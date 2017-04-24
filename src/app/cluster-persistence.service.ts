import { Injectable } from '@angular/core';
import { Observable, BehaviorSubject, Subscription } from 'rxjs/Rx';

import * as firebase from "firebase";

import { Cluster } from './cluster';
import { ClusterData } from './cluster-data';
import { ClusterSerializerXML } from './cluster-serializer-xml';
import { User } from './user';
import { ASCII_US, uniqueClusterName, minimalEncode, minimalDecode } from './utils';

// I'm thinking this thing stores serialized XML somewhere and retrieves it from somewhere.
//
// Maybe into a global variable (how do we set that up) and via a text field somewhere (how do we set that up)?  In
// future, a FireBase d/b, maybe?  Need to get credentials from user for FireBase.

/**
 * Makes several Observables available, which point to various parts of the persistent data store in Firebase.
 * See nosql.org to d/b structure.
 */
@Injectable()
export class ClusterPersistenceService 
{
   // --------------------------------------------  Public Data, Accessors  --------------------------------------------
   
   /**
    * Current User.
    */
   public get currentUser(): User { return this._curUser; }

   /**
    * The current cluster (which may not have been saved yet), as a Subject.
    */
   public get currentClusterSubject(): BehaviorSubject<Cluster> {
      return this._currentGeneratedCluster
         || this._currentPersistedCluster;
   }

   /**
    * The current cluster (which may not have been saved yet, and/or, in the case of a persisted cluster, may be out of
    * date).
    */
   public get currentCluster(): Cluster {
      return (this._currentGeneratedCluster && this._currentGeneratedCluster.value)
         || (this._currentPersistedCluster && this._currentPersistedCluster.value);
   }

   public set currentGeneratedCluster( aCluster: Cluster) {
      if (this._currentPersistedCluster || this._currentPersistedClusterSubscription)
      {
         if (this._currentPersistedClusterSubscription)
            this._currentPersistedClusterSubscription.unsubscribe();
         // TODO: unsubscribe or whatever needs to be done (the above is just a guess).
      }
      this._currentGeneratedCluster = new BehaviorSubject<Cluster>( aCluster);
   }

   /**
    * Map from cluster name to cluster meadata (e.g., last edited by/when, notes, etc.)
    */
   public get clusterMetadata(): Observable<Cluster[]> { return this._clusterMetadata; }

   /**
    * Current cluster from persistent (possibly shared) store.
    */
   private get currentPersistedCluster(): BehaviorSubject<Cluster> { return this._currentPersistedCluster; }
   
   // -------------------------------------------------  Private Data  -------------------------------------------------
   
   /**
    * Map from cluster unique name to Cluster.  Zero or more of these clusters will have all data filled in (and not
    * necessarily up to date); the rest will have only metadata.
    */ 
   private _latestClusterMap: Map<string, Cluster>;
   
   private _firebaseConfig = {
            apiKey: "AIzaSyBiNVpydoOUGJiIavCB3f8qvB6ARYSy_1E",
            authDomain: "diaspora-21544.firebaseapp.com",
            databaseURL: "https://diaspora-21544.firebaseio.com",
            storageBucket: "diaspora-21544.appspot.com",
            messagingSenderId: "222484722746"
      };

   // private _ui: any;            // Firebase ui
   private _db: firebase.database.Database;
   private _authProvider: firebase.auth.GoogleAuthProvider;
   private _googleAccessToken: firebase.auth.AuthCredential;

   private _userPromise: Promise<User>;

   private _users: Observable<Map<string,User>>;
   private _latestUserMap: Map<string,User>;
   
   // On "deferred" promises: this is for the situation in which, when we create the promise ("new Promise(...)"), we do
   // not start the asynchronous/blocking work that will result in promise fulfillment.  Instead, that work has either
   // already been started or will be started elsewhere/elsewhen.  So, we simply save off an object holding pointers to
   // the resolve/reject functions so we can call them later (which we do).  See the handling of
   // this._userPromiseDeferred in this service.
   // 
   // See
   // http://stackoverflow.com/questions/31069453/creating-a-es6-promise-without-starting-to-resolve-it/31069505#31069505
   //
   private _userPromiseDeferred: {resolve: any, reject: any};
   
   private _clusterMetadata: BehaviorSubject<Cluster[]>;

   private _currentGeneratedCluster: BehaviorSubject<Cluster>;

   private _currentGeneratedClusterSubscription: Subscription;
   
   private _currentPersistedCluster: BehaviorSubject<Cluster>;

   private _currentPersistedClusterSubscription: Subscription;
   
   private _curUser: User;
   
   private _initialized: boolean = false;

   private _xmlSerializer: ClusterSerializerXML;
   
   // -------------------------------------------------  Constructors  -------------------------------------------------
   
   constructor( )
   {
      let me = this.constructor.name + '.ctor(): '
      console.log( me + `=============================================================================================`);
   }

   // ------------------------------------------------  Public Methods  ------------------------------------------------
   
   /**
    * Initialize firebase and hook up AuthStateChanged event.
    */
   public init(): void
   {
      let me = this.constructor.name + '.init(): ';
      console.log( me);
      if (this._initialized)    // Probably not threadsafe, but I'll think about that tomorrow.  After all, tomorrow is another day.
      {
         console.log( me + "already initialized");
         return;
      }

      this._xmlSerializer = new ClusterSerializerXML();
      
      firebase.initializeApp( this._firebaseConfig);

      this._userPromise = new Promise(
         ( resolve, reject) => this._userPromiseDeferred = {resolve: resolve, reject: reject});
      
      firebase.auth().onAuthStateChanged( this.authStateChanged.bind( this), this.authError.bind( this));

      this._initialized = true;
      console.log( me + "initialized");
   }

   /**
    * Make Observables for various items in the Firebase database, from Firebase events.
    */
   public connectToDatabase()
   {
      let me = this.constructor.name + '.connectToDatabase(): ';

      this._db = firebase.database();
      console.log( me + `initialized firebase, db = "${this._db}"`);

      this._clusterMetadata = new BehaviorSubject<Cluster[]>(new Array<Cluster>());
      
      let clusterMetadataSubscription = this.makeDatabaseSnapshotObservable( '/clusters')
         .map( s => this.parseMetadata( s.val()))
         .multicast( this._clusterMetadata)
         .connect();

      this._users = this.makeDatabaseSnapshotObservable( '/users').map( s => this.parseUsers( s.val()));
      this._users.subscribe( map => {this._latestUserMap = map;});

      // TODO: make Behavior Subject containing cluster arrays?  Answer: YES, probably a good idea.  Then we wouldn't
      // need to bother with this "latest" junk, because a BehaviorSubject will always have the latest value.

      // let subscription = this._clusterNamesObservable.subscribe(
      //    (snapshot: firebase.database.DataSnapshot) => this.clusterNamesValueChanged( snapshot)
      //    ,(err) => this.firebaseError( err) // Doesn't work.
      // );
   }

   /**
    * Returns a User object for the given uid. May return null.
    */
   public getUser( aUid: string): User
   {
      let retval: User;
      if (this._latestUserMap)
         retval = this._latestUserMap.get( aUid);
      return retval;
   }

//   /**
//    * Initiates a request to load the filled-in details of the cluster and returns whatever we have now in the cluster map.
//    * See also {@link #currentCluster} property.
//    */ 
//   public getCluster( aCluster: Cluster): Cluster
//   {
//      this.loadCluster( aCluster.uniqueName());
//      let retval = this._latestClusterMap.get( aCluster.uniqueName());
//      return retval;
//   }

   /**
    * Initiate login to Firebase.
    */
   public login(): void
   {
      let me =  this.constructor.name + ".login(): ";
      console.log( me);
      if (! this._authProvider)
         this._authProvider = new firebase.auth.GoogleAuthProvider();
      console.log( me + "signing in with redirect");
      // alert( "signing in w/redirect");
      firebase.auth().signInWithRedirect( this._authProvider);
      // alert( "about to process redirect result");
      firebase.auth().getRedirectResult().then( (function( result: firebase.auth.UserCredential) {
         if (result.credential) {
            this._googleAccessToken = result.credential;
            console.log( me + `accessToken = "${this._googleAccessToken}`);
         }
         this._user = result.user;
         console.log( me + `logged in user "${this._user}"`);
         // alert( "login done");
      }).bind( this)).catch( (function( error: Error) {
         console.log( `${me} ${error.message}`)}).bind( this));
      console.log( me + 'done');
   }

   public logout()
   {
      let me = this.constructor.name + ".logout(): ";
      // alert( "logging out");
      console.log( me);
      firebase.auth().signOut().then( function() {
         console.log( "signout successful");
      }).catch( function( anError: Error) {
         console.log( `signout error: ${anError.message}`);
      });
   }
   
   public get user(): Promise<User>
   {
      return this._userPromise;
   }
   
//   /**
//    * Returns a list of "shallow" clusters -- each cluster only contains metadata, not the full cluster data.
//    */
//   getClusters(): Cluster[]     // TODO: probably don't need this and can delete.
//   {
//      let me = this.constructor.name + ".getClusterNames(): ";
//      console.log( me + `getClusterNames()`);
//      return new Array<Cluster>();
//   }
   
   public loadCluster( aUniqueName: string): void
   {
      let me = this.constructor.name + ".loadCluster(): ";
      let uniqueName = JSON.stringify( minimalEncode( aUniqueName));
      console.log( me + `loading ${uniqueName}`);
      if (this._currentPersistedCluster || this._currentPersistedClusterSubscription)
      {
         if (this._currentPersistedClusterSubscription)
            this._currentPersistedClusterSubscription.unsubscribe();
         if (this._currentGeneratedClusterSubscription)
         {
            this._currentGeneratedClusterSubscription.unsubscribe();
            this._currentGeneratedClusterSubscription = null;
         }
         if (this._currentGeneratedCluster)
            this._currentGeneratedCluster = null;
         
         // TODO: unsubscribe or whatever needs to be done (the above is just a guess).
      }
      this._currentPersistedCluster = new BehaviorSubject<Cluster>( new Cluster());
      this._currentPersistedClusterSubscription = this.makeDatabaseSnapshotObservable( `/clusterData/${uniqueName}`)
         .map( s => this.parseClusterData( s.val()))
         .multicast( this._currentPersistedCluster)
         .connect();
   }

   public deleteCluster( aUniqueName: string):void
   {
      let me = this.constructor.name + ".deleteCluster(): ";
      let uniqueName = JSON.stringify( aUniqueName);
      console.log( me + `deleting ${uniqueName}`);
      if (this._currentGeneratedClusterSubscription)
      {
         this._currentPersistedClusterSubscription.unsubscribe();
         this._currentPersistedClusterSubscription = null;
      }

      if (! this._db) this._db = firebase.database();
      this._db.ref( `/clusters/${uniqueName}`).remove();
      this._db.ref( `/clusterData/${uniqueName}`).remove();
   }
   
   public saveCluster( aCluster: Cluster): void
   {
      let uniqueName = JSON.stringify( minimalEncode( uniqueClusterName( aCluster, this._curUser)));
      let dbRef = this._db.ref();
      let updates = Object.create( null);

      let clusterProps = { lastChanged: new Date( Date.now()) };
      updates[`/clusters/${uniqueName}`] = clusterProps;

      this._xmlSerializer.cluster = aCluster;
      let xml = this._xmlSerializer.serialize();
      let owners = Object.create( null);
      owners[ `${this._curUser.uid}`] = 1;
      let clusterDataProps = { xml: xml,
                               owners: owners
                             };
      updates[`/clusterData/${uniqueName}`] = clusterDataProps;

      dbRef.update( updates);
   }

   /**
    * Get cluster xml from some place wondrous and mysterious (like a server).
    */
   public getClusterXml(): string
   {
      return "";
   }

   // -----------------------------------------------  Private Methods  ------------------------------------------------
   
   private authStateChanged( aFirebaseUser): void
   {
      let me = this.constructor.name + '.authStateChanged(): ';
      // let user: User;
      if (aFirebaseUser)
      {
         this._curUser = new User( aFirebaseUser.uid,
                          aFirebaseUser.displayName || aFirebaseUser.email || aFirebaseUser.uid,
                          aFirebaseUser.email,
                          new Date( Date.now()));
         console.log( me + `User logged in: ${this._curUser} with provider ${aFirebaseUser.providerId}`);
         if (this._curUser.uid)
         {
            let uidRef = this._db.ref( `/users/${this._curUser.uid}`);
            console.log( me + `uidRef = ${uidRef}`);
            let userProps = { name: this._curUser.name,
                              email: this._curUser.email,
                              lastLogin: this._curUser.lastLogin.toISOString(),
                              timeZoneOffset: this._curUser.lastLogin.getTimezoneOffset()
                            };
            uidRef.update( userProps); // Performs insert if key doesn't exist, so that's good.
         }
         else
            console.log( me + `WARNING: no uid for user ${this._curUser.name}`);
      }
      else
      {
         console.log( me + 'auth state changed, but passed user is null or empty, assuming logged out');
         this._curUser = null;
      }
      this._userPromiseDeferred.resolve( this._curUser); // We know _userPromiseDeferred won't be null because we create it
                                                      // before hooking up this event handler.
   }

   private authError( aFirebaseAuthError): void
   {
      let me = this.constructor.name + '.authError(): ';
      console.log( me + `auth error: ${aFirebaseAuthError.message}`);
      this._userPromiseDeferred.reject( aFirebaseAuthError);
   }

   private makeDatabaseSnapshotObservable( aNoSqlTreeNodeName: string): Observable<firebase.database.DataSnapshot>
   {
      if (! this._db) this._db = firebase.database();
      let dbRef = this._db.ref( aNoSqlTreeNodeName);
      let retval = Observable.fromEventPattern(
         (function addHandler( h: (a: firebase.database.DataSnapshot, b?: string) => any) {
            // Need to explicitly bind to firebaseError here because there's no easy way (that I can tell) to
            // generate/catch errors using the Observable subscription.
            dbRef.on( 'value', h, this.firebaseError); }).bind(this), 
         function delHandler( h: (a: firebase.database.DataSnapshot, b?: string) => any) {
            dbRef.off( 'value', h);
         }
         // ,(aSnapshot: firebase.database.DataSnapshot) => aSnapshot
      );
      return retval
         // .map((s,i) => <firebase.database.DataSnapshot>s)
      ;
   }

   private firebaseError( anError: Error): void
   {
      let me = "ClusterPersistenceService.firebaseError(): "; // this.constructor.name + ".firebaseError(): ";
      console.log( me + `firebaseError(): ` + anError.message);
      // if (anError.message.match( /^permission_denied/))
      //    this.login();
   }

   /**
    * Returns a map from cluster name to cluster metadata (e.g., last edited by/when, notes), which map is created from
    * the given d/b snapshot.
    */
   private parseMetadata( aSnapshot: Object): Cluster[]
   {
      let me = this.constructor.name + ".parseMetadata(): ";
      this._latestClusterMap = new Map<string, Cluster>();
      let retval = Array<Cluster>();
      for (let key in aSnapshot)
      {
         let keyTuple = minimalDecode( JSON.parse( key));
         let [name,uid] = keyTuple.split( ASCII_US, 2);
         name = JSON.parse( name);
         let clusterObj = <Cluster> aSnapshot[key]; // Note: just casting an Object (which is what I think aSnapshot[key]
                                                 // is, since Firebase knows nothing about our class hierarchy) to
                                                 // Cluster does not actually MAKE the thing a Cluster, it just
                                                 // satisfies TypeScript's demand for type "congruence".
         // clusterObj.lastAuthor = uid;
         // clusterObj.name = name;

         let cluster = new Cluster();
         cluster.lastChanged = clusterObj.lastChanged;
         cluster.lastAuthor = uid;
         cluster.name = name;

         retval.push( cluster); 
         this._latestClusterMap.set( key, cluster);
      }
      console.log( me + `aSnapshot contains ${retval.length} clusters`);
      return retval;
   }

   private parseClusterData( aSnapshot: Object): Cluster
   {
      let me = this.constructor.name + ".parseClusterData(): ";
      let snapshot = <ClusterData> aSnapshot; // TODO
      let serializer = new ClusterSerializerXML();
      let errors = serializer.deserialize( snapshot.xml);
      if (errors)
         console.log( me + `ERRORS:\n\t${errors}`);
      return serializer.cluster;
   }
   
   private parseUsers( aSnapshot: Object): Map<string,User> {
      let me = this.constructor.name + ".parseUsers(): ";
      let retval = new Map<string,User>();
      for (let uid in aSnapshot)
      {
         let user = aSnapshot[uid];
         user.uid = uid;
         retval.set(uid, user);
      }
      console.log( me + `snapshot contains ${retval.size} users`);
      return retval;
   }
   
}
