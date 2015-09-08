////// ----------------------- Connection "class" ---------------------- ////////////
/* jshint browser:true */
/* global document*/
/* global console*/
/* global session*/
/* global window*/
/* global location*/
/* global setTimeout*/
/* global clearTimeout*/
/* global io*/
/* global $*/
/* global socketNamespace */
/* global socketUrl */
/* global socketSession */
/* global storage */
/* jshint -W097 */// jshint strict:false

"use strict";

// The idea of servConn is to use this class later in every addon.
// The addon just must say, what must be loaded (values, objects, indexes) and
// the class loads it for addon. Authentication will be done automatically, so addon does not care about it.
// It will be .js file with localData and servConn

var servConn = {
    _socket:            null,
    _onConnChange:      null,
    _onUpdate:          null,
    _isConnected:       false,
    _disconnectedSince: null,
    _connCallbacks:     {
        onConnChange: null,
        onUpdate:     null,
        onRefresh:    null,
        onAuth:       null,
        onCommand:    null,
        onError:      null
    },
    _authInfo:          null,
    _isAuthDone:        false,
    _isAuthRequired:    false,
    _authRunning:       false,
    _cmdQueue:          [],
    _connTimer:         null,
    _type:              'socket.io', // [SignalR | socket.io | local]
    _timeout:           0,           // 0 - use transport default timeout to detect disconnect
    _reconnectInterval: 10000,       // reconnect interval
    _subscribes:        [],
    _cmdData:           null,
    _cmdInstance:       null,
    _isSecure:          false,
    _defaultMode:       0x644,
    _useStorage:        false,
    _objects:           null,        // used if _useStorage == true
    _enums:             null,        // used if _useStorage == true
    namespace:          'vis.0',

    getType:          function () {
        return this._type;
    },
    getIsConnected:   function () {
        return this._isConnected;
    },
    getIsLoginRequired: function () {
        return this._isSecure;
    },
    getUser:          function () {
        return this._user;
    },
    _checkConnection: function (func, _arguments) {
        if (!this._isConnected) {
            console.log('No connection!');
            return false;
        }

        if (this._queueCmdIfRequired(func, _arguments)) return false;

        //socket.io
        if (this._socket === null) {
            console.log('socket.io not initialized');
            return false;
        }
        return true;
    },
    _monitor:         function () {
        if (this._timer) return;
        var ts = (new Date()).getTime();
        if (ts - this._lastTimer > 30000) {
            // It seems, that PC was in a sleep => Reload page to request authentication anew
            location.reload();
        } else {
            this._lastTimer = ts;
        }
        var that = this;
        this._timer = setTimeout(function () {
            that._timer = null;
            that._monitor();
        }, 10000);
    },
    _onAuth:          function (objectsRequired, isSecure) {
        var that = this;

        this._isSecure = isSecure;

        if (this._isSecure) {
            that._lastTimer = (new Date()).getTime();
            this._monitor();
        }

        this._socket.emit('subscribe', '*');
        if (objectsRequired) this._socket.emit('subscribeObjects', '*');

        if (this._isConnected === true) {
            // This seems to be a reconnect because we're already connected!
            // -> prevent firing onConnChange twice
            return;
        }
        this._isConnected = true;
        if (this._connCallbacks.onConnChange) {
            setTimeout(function () {
                that._socket.emit('authEnabled', function (auth, user) {
                    that._user = user;
                    that._connCallbacks.onConnChange(that._isConnected);
                });
            }, 0);
        }
    },
    init:             function (connOptions, connCallbacks, objectsRequired) {
        // To start vis as local use one of:
        // - start vis from directory with name local, e.g. c:/blbla/local/ioBroker.vis/www/index.html
        // - do not create "_socket/info.js" file in "www" directory
        // - create "_socket/info.js" file with
        //   var socketUrl = "local"; var socketSession = ""; sysLang="en";
        //   in this case you can overwrite browser language settings
        if ((document.URL.split('/local/')[1] || (typeof socketUrl === 'undefined' || socketUrl === 'local'))) {
            this._type =  'local';
        }

        // init namespace
        if (typeof socketNamespace != 'undefined') this.namespace = socketNamespace;

        connOptions = connOptions || {};
        var that = this;
        if (!connOptions.name) connOptions.name = this.namespace;

        if (typeof session !== 'undefined') {
            var user = session.get('user');
            if (user) {
                that._authInfo = {
                    user: user,
                    hash: session.get('hash'),
                    salt: session.get('salt')
                };
            }
        }

        this._connCallbacks = connCallbacks;

        var connLink = connOptions.connLink || window.localStorage.getItem('connLink');

        // Connection data from "/_socket/info.js"
        if (!connLink && typeof socketUrl != 'undefined') connLink = socketUrl;
        if (!connOptions.socketSession && typeof socketSession != 'undefined') connOptions.socketSession = socketSession;

        // if no remote data
        if (this._type === 'local') {
            // report connected state
            this._isConnected = true;
            if (this._connCallbacks.onConnChange) this._connCallbacks.onConnChange(this._isConnected);
        } else
        if (typeof io != 'undefined') {
            connOptions.socketSession = connOptions.socketSession || 'nokey';

            var url;
            if (connLink) {
                url = connLink;
                if (typeof connLink != 'undefined') {
                    if (connLink[0] == ':') connLink = location.protocol + '://' + location.hostname + connLink;
                }
            } else {
                url = location.protocol + '//' + location.host;
            }

            this._socket = io.connect(url, {
                'query': 'key=' + connOptions.socketSession,
                'reconnection limit': 10000,
                'max reconnection attempts': Infinity
            });

            this._socket.on('connect', function () {
                this._socket.emit('name', connOptions.name);
				console.log((new Date()).toISOString() + ' Connected => authenticate');
                setTimeout(function () {
                    this._socket.emit('authenticate', function (isOk, isSecure) {
                        console.log((new Date()).toISOString() + ' Authenticated: ' + isOk);
                        if (isOk) {
                            this._onAuth(objectsRequired, isSecure);
                        } else {
                            console.log('permissionError');
                        }
                    }.bind(this));
                }.bind(this), 50);
            }.bind(this));

            this._socket.on('reauthenticate', function () {
                if (this._connCallbacks.onReAuth) {
                    this._connCallbacks.onConnChange(this._isSecure);
                } else {
                    location.reload();
                }
            }.bind(this));

            this._socket.on('disconnect', function () {
                //console.log("socket.io disconnect");
                this._disconnectedSince = (new Date()).getTime();

                this._isConnected = false;
                if (this._connCallbacks.onConnChange) {
                    this.disconnectTimeout = setTimeout(function () {
                        this._connCallbacks.onConnChange(this._isConnected);
                    }.bind(this), 5000);
                }
            }.bind(this));

            // after reconnect the "connect" event will be called
            this._socket.on('reconnect', function () {
                //console.log("socket.io reconnect");
                var offlineTime = (new Date()).getTime() - that._disconnectedSince;
                console.log('was offline for ' + (offlineTime / 1000) + 's');

                // TODO does this make sense?
                //if (offlineTime > 12000) {
                    //window.location.reload();
                //}
                //that._autoReconnect();
            }.bind(this));

            this._socket.on('objectChange', function (id, obj) {
                if (this._connCallbacks.onObjectChange) this._connCallbacks.onObjectChange(id, obj);
            }.bind(this));

            this._socket.on('stateChange', function (id, state) {
                if (!id || state === null || typeof state != 'object') return;

                if (this._connCallbacks.onCommand && id == that.namespace + '.control.command') {
                    if (state.ack) return;

                    if (state.val &&
                        typeof state.val == 'string' &&
                        state.val[0] == '{' &&
                        state.val[state.val.length - 1] == '}') {
                        try {
                            state.val = JSON.parse(state.val);
                        } catch (e) {
                            console.log('Command seems to be an object, but cannot parse it: ' + state.val);
                        }
                    }

                    // if command is an object {instance: 'iii', command: 'cmd', data: 'ddd'}
                    if (state.val && state.val.instance) {
                        if (this._connCallbacks.onCommand(state.val.instance, state.val.command, state.val.data)) {
                            // clear state
                            this.setState(id, {val: '', ack: true});
                        }
                    } else {
                        if (this._connCallbacks.onCommand(this._cmdInstance, state.val, this._cmdData)) {
                            // clear state
                            this.setState(id, {val: '', ack: true});
                        }
                    }
                } else if (id == that.namespace + '.control.data') {
                    this._cmdData = state.val;
                } else if (id == that.namespace + '.control.instance') {
                    this._cmdInstance = state.val;
                } else if (this._connCallbacks.onUpdate) {
                    this._connCallbacks.onUpdate(id, state);
                }
            }.bind(this));

            this._socket.on('permissionError', function (err) {
                if (this._connCallbacks.onError) {
                    /* {
                     command:
                     type:
                     operation:
                     arg:
                     }*/
                    this._connCallbacks.onError(err);
                } else {
                    console.log('permissionError');
                }
            }.bind(this));
        }
    },
    logout:           function (callback) {
        if (!this._isConnected) {
            console.log("No connection!");
            return;
        }

        this._socket.emit('logout', callback);
    },
    getVersion:       function (callback) {
        if (!this._checkConnection('getVersion', arguments)) return;

        this._socket.emit('getVersion', function (version) {
            if (callback) callback(version);
        });
    },
    _checkAuth:       function (callback) {
        if (!this._isConnected) {
            console.log("No connection!");
            return;
        }
        //socket.io
        if (this._socket === null) {
            console.log('socket.io not initialized');
            return;
        }
        this._socket.emit('getVersion', function (version) {
            if (callback)
                callback(version);
        });
    },
    readFile:         function (filename, callback) {
        if (!callback) throw 'No callback set';

        if (this._type === 'local') {
            try {
                var data = storage.get(filename);
                callback(null, data ? JSON.parse(storage.get(filename)) : null);
            } catch (err) {
                callback(err, null);
            }
        } else {
            if (!this._checkConnection('readFile', arguments)) return;

            this._socket.emit('readFile', this.namespace, filename, function (err, data) {
                setTimeout(function () {
                    callback(err, data);
                }, 0);
            });
        }
    },
    readFile64:       function (filename, callback) {
        if (!callback) {
            throw 'No callback set';
        }
        this._socket.emit('readFile', this.namespace, filename, function (err, data) {
            if (data) {
                var ext = filename.match(/\.[^.]+$/);
                var _mimeType;
                if (ext == '.css') {
                    _mimeType = 'text/css';
                } else if (ext == '.bmp') {
                    _mimeType = 'image/bmp';
                } else if (ext == '.png') {
                    _mimeType = 'image/png';
                } else if (ext == '.jpg') {
                    _mimeType = 'image/jpeg';
                } else if (ext == '.jpeg') {
                    _mimeType = 'image/jpeg';
                } else if (ext == '.gif') {
                    _mimeType = 'image/gif';
                } else if (ext == '.tif') {
                    _mimeType = 'image/tiff';
                } else if (ext == '.js') {
                    _mimeType = 'application/javascript';
                } else if (ext == '.html') {
                    _mimeType = 'text/html';
                } else if (ext == '.htm') {
                    _mimeType = 'text/html';
                } else if (ext == '.json') {
                    _mimeType = 'application/json';
                } else if (ext == '.xml') {
                    _mimeType = 'text/xml';
                } else if (ext == '.svg') {
                    _mimeType = 'image/svg+xml';
                } else if (ext == '.eot') {
                    _mimeType = 'application/vnd.ms-fontobject';
                } else if (ext == '.ttf') {
                    _mimeType = 'application/font-sfnt';
                } else if (ext == '.woff') {
                    _mimeType = 'application/font-woff';
                } else if (ext == '.wav') {
                    _mimeType = 'audio/wav';
                } else if (ext == '.mp3') {
                    _mimeType = 'audio/mpeg3';
                } else {
                    _mimeType = 'text/javascript';
                }

                callback(err, {mime: _mimeType, data: btoa(data)});
            } else {
                callback(err);
            }
        });
    },
    writeFile:        function (filename, data, mode, callback) {
        if (typeof mode == 'function') {
            callback = mode;
            mode = null;
        }
        var that = this;
        if (this._type === 'local') {
            storage.set(filename, JSON.stringify(data));
            if (callback) callback();
        } else {
            if (!this._checkConnection('writeFile', arguments)) return;

            if (typeof data == 'object') data = JSON.stringify(data, null, 2);

            this._socket.emit('writeFile', this.namespace, filename, data, mode ? {mode: this._defaultMode} : {}, callback);
        }
    },
    // Write file base 64
    writeFile64:      function (filename, data, callback) {
        var that = this;
        if (!this._checkConnection('writeFile', arguments)) return;

        var parts = filename.split('/');
        var adapter = parts[1];
        parts.splice(0, 2);

        this._socket.emit('writeFile', adapter, parts.join('/'), atob(data), {mode: this._defaultMode}, callback);
    },
    readDir:          function (dirname, callback) {
        //socket.io
        if (this._socket === null) {
            console.log('socket.io not initialized');
            return;
        }
        if (!dirname) dirname = '/';
        var parts = dirname.split('/');
        var adapter = parts[1];
        parts.splice(0, 2);

        this._socket.emit('readDir', adapter, parts.join('/'), {filter: true}, function (err, data) {
            if (callback) callback(err, data);
        });
    },
    mkdir:            function (dirname, callback) {
        var parts = dirname.split('/');
        var adapter = parts[1];
        parts.splice(0, 2);

        this._socket.emit('mkdir', adapter, parts.join('/'), function (err) {
            if (callback) callback(err);
        });
    },
    unlink:           function (name, callback) {
        var parts = name.split('/');
        var adapter = parts[1];
        parts.splice(0, 2);

        this._socket.emit('unlink', adapter, parts.join('/'), function (err) {
            if (callback) callback(err);
        });
    },
    renameFile:       function (oldname, newname, callback) {
        var parts1 = oldname.split('/');
        var adapter = parts1[1];
        parts1.splice(0, 2);
        var parts2 = newname.split('/');
        parts2.splice(0, 2);
        this._socket.emit('rename', adapter, parts1.join('/'), parts2.join('/'), function (err) {
            if (callback) callback(err);
        });
    },
    setState:         function (pointId, value, callback) {
        //socket.io
        if (this._socket === null) {
            //console.log('socket.io not initialized');
            return;
        }
        this._socket.emit('setState', pointId, value, callback);
    },
    // callback(err, data)
    getStates:        function (IDs, callback) {
        if (this._type === 'local') {
            return callback(null, []);
        }else {

            if (typeof IDs == 'function') {
                callback = IDs;
                IDs = null;
            }

            if (!this._checkConnection('getStates', arguments)) return;

            this._socket.emit('getStates', IDs, function (err, data) {
                if (err || !data) {
                    if (callback) {
                        callback(err || 'Authentication required');
                    }
                } else if (callback) {
                    callback(null, data);
                }
            });
        }
    },
    _fillChildren:    function (objects) {
        var items = [];

        for (var id in objects) {
            items.push(id);
        }
        items.sort();

        for (var i = 0; i < items.length; i++) {
            if (objects[items[i]].common) {
                var j = i + 1;
                var children = [];
                var len      = items[i].length + 1;
                var name     = items[i] + '.';
                while (j < items.length && items[j].substring(0, len) == name) children.push(items[j++]);

                objects[items[i]].children = children;
            }
        }
    },
    // callback(err, data)
    getObjects:       function (useCache, callback) {
        if (typeof useCache === 'function') {
            callback = useCache;
            useCache = false;
        }
        // If cache used
        if (this._useStorage && useCache) {
            if (typeof storage !== 'undefined') {
                var objects = this._objects || storage.get('objects');
                if (objects) return callback(null, objects);
            } else if (this._objects) {
                return callback(null, this._objects);
            }
        }

        if (!this._checkConnection('getObjects', arguments)) return;
        var that = this;
        this._socket.emit('getObjects', function (err, data) {

            // Read all enums
            that._socket.emit('getObjectView', 'system', 'enum', {startkey: 'enum.', endkey: 'enum.\u9999'}, function (err, res) {
                if (err) {
                    callback(err);
                    return;
                }
                var result = {};
                var enums  = {};
                for (var i = 0; i < res.rows.length; i++) {
                    data[res.rows[i].id] = res.rows[i].value;
                    enums[res.rows[i].id] = res.rows[i].value;
                }

                // Read all adapters for images
                that._socket.emit('getObjectView', 'system', 'instance', {startkey: 'system.adapter.', endkey: 'system.adapter.\u9999'}, function (err, res) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    var result = {};
                    for (var i = 0; i < res.rows.length; i++) {
                        data[res.rows[i].id] = res.rows[i].value;
                    }
                    // find out default file mode
                    if (data['system.adapter.' + that.namespace] &&
                        data['system.adapter.' + that.namespace].native &&
                        data['system.adapter.' + that.namespace].native.defaultFileMode) {
                        that._defaultMode = data['system.adapter.' + that.namespace].native.defaultFileMode;
                    }

                    // Read all channels for images
                    that._socket.emit('getObjectView', 'system', 'channel', {startkey: '', endkey: '\u9999'}, function (err, res) {
                        if (err) {
                            callback(err);
                            return;
                        }
                        var result = {};
                        for (var i = 0; i < res.rows.length; i++) {
                            data[res.rows[i].id] = res.rows[i].value;
                        }

                        // Read all devices for images
                        that._socket.emit('getObjectView', 'system', 'device', {startkey: '', endkey: '\u9999'}, function (err, res) {
                            if (err) {
                                callback(err);
                                return;
                            }
                            var result = {};
                            for (var i = 0; i < res.rows.length; i++) {
                                data[res.rows[i].id] = res.rows[i].value;
                            }

                            if (that._useStorage) {
                                that._fillChildren(data);
                                that._objects = data;
                                that._enums   = enums;

                                if (typeof storage !== 'undefined') {
                                    storage.set('objects',  data);
                                    storage.set('enums',    enums);
                                    storage.set('timeSync', (new Date()).getTime());
                                }
                            }

                            if (callback) callback(err, data);
                        });
                    });
                });
            });
        });
    },
    getChildren:      function (id, useCache, callback) {
        if (!this._checkConnection('getChildren', arguments)) return;

        if (typeof id == 'function') {
            callback = id;
            id = null;
            useCache = false;
        }
        if (typeof id == 'boolean') {
            callback = useCache;
            useCache = id;
            id = null;
        }
        if (typeof useCache == 'function') {
            callback = useCache;
            useCache = false;
        }

        if (!id) return callback('getChildren: no id given');

        var that = this;
        var data = [];

        if (this._useStorage && useCache) {
            if (typeof storage !== 'undefined') {
                var objects = storage.get('objects');
                if (objects && objects[id] && objects[id].children) {
                    return callback(null, objects[id].children);
                }
            } else if (this._objects && this._objects[id] && this._objects[id].children) {
                return callback(null, this._objects[id].children);
            }
        }

        // Read all devices
        that._socket.emit('getObjectView', 'system', 'device', {startkey: id + '.', endkey: id + '.\u9999'}, function (err, res) {
            if (err) {
                callback(err);
                return;
            }
            var result = {};
            for (var i = 0; i < res.rows.length; i++) {
                data[res.rows[i].id] = res.rows[i].value;
            }

            that._socket.emit('getObjectView', 'system', 'channel', {startkey: id + '.', endkey: id + '.\u9999'}, function (err, res) {
                if (err) {
                    callback(err);
                    return;
                }
                var result = {};
                for (var i = 0; i < res.rows.length; i++) {
                    data[res.rows[i].id] = res.rows[i].value;
                }

                // Read all adapters for images
                that._socket.emit('getObjectView', 'system', 'state', {startkey: id + '.', endkey: id + '.\u9999'}, function (err, res) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    var result = {};
                    for (var i = 0; i < res.rows.length; i++) {
                        data[res.rows[i].id] = res.rows[i].value;
                    }
                    var list = [];

                    var count = id.split('.');

                    // find direct children
                    for (var _id in data) {
                        var parts = _id.split('.');
                        if (count + 1 == parts.length) {
                            list.push(_id);
                        }
                    }
                    list.sort();

                    if (this._useStorage && typeof storage !== 'undefined') {
                        var objects = storage.get('objects') || {};

                        for (var _id in data) {
                            objects[_id] = data[_id];
                        }
                        if (objects[id] && objects[id].common) {
                            objects[id].children = list;
                        }
                        // Store for every element theirs children
                        var items = [];
                        for (var _id in data) {
                            items.push(_id);
                        }
                        items.sort();

                        for (var i = 0; i < items.length; i++) {
                            if (objects[items[i]].common) {
                                var j = i + 1;
                                var children = [];
                                var len  = items[i].length + 1;
                                var name = items[i] + '.';
                                while (j < items.length && items[j].substring(0, len) == name) children.push(items[j++]);

                                objects[items[i]].children = children;
                            }
                        }

                        storage.set('objects', objects);
                    }

                    if (callback) callback(err, list);
                }.bind(this));
            }.bind(this));
        }.bind(this));
    },
    getObject:        function (id, useCache, callback) {
        if (typeof id == 'function') {
            callback = id;
            id = null;
            useCache = false;
        }
        if (typeof id == 'boolean') {
            callback = useCache;
            useCache = id;
            id = null;
        }
        if (typeof useCache == 'function') {
            callback = useCache;
            useCache = false;
        }
        if (!id) return callback('no id given');

        // If cache used
        if (this._useStorage && useCache && typeof storage !== 'undefined') {
            if (typeof storage !== 'undefined') {
                var objects = this._objects || storage.get('objects');
                if (objects && objects[id]) return callback(null, objects[id]);
            } else if (this._enums) {
                return callback(null, this._enums);
            }
        }

        this._socket.emit('getObject', id, function (err, obj) {
            if (err) {
                callback(err);
                return;
            }
            if (this._useStorage && typeof storage !== 'undefined') {
                var objects = storage.get('objects') || {};
                objects[id] = obj;
                storage.set('objects', objects);
            }
            return callback(null, obj);
        }.bind(this));
    },
    getEnums:         function (enumName, useCache, callback) {
        if (typeof enumName == 'function') {
            callback = enumName;
            enumName = null;
            useCache = false;
        }
        if (typeof enumName == 'boolean') {
            callback = useCache;
            useCache = enumName;
            enumName = null;
        }
        if (typeof useCache == 'function') {
            callback = useCache;
            useCache = false;
        }

        // If cache used
        if (this._useStorage && useCache) {
            if (typeof storage !== 'undefined') {
                var enums = this._enums || storage.get('enums');
                if (enums) return callback(null, enums);
            } else if (this._enums) {
                return callback(null, this._enums);
            }
        }

        if (this._type === 'local') {
            return callback(null, []);
        } else {

            enumName = enumName ? enumName + '.' : '';

            // Read all enums
            this._socket.emit('getObjectView', 'system', 'enum', {startkey: 'enum.' + enumName, endkey: 'enum.' + enumName + '\u9999'}, function (err, res) {
                if (err) {
                    callback(err);
                    return;
                }
                var enums = {};
                for (var i = 0; i < res.rows.length; i++) {
                    var obj = res.rows[i].value;
                    enums[obj._id] = obj;
                }
                if (this._useStorage && typeof storage !== 'undefined') {
                    storage.set('enums', enums);
                }
                callback(null, enums);
            }.bind(this));
        }
    },
    // return time when the objects were synchronized
    getSyncTime:     function () {
        if (this._useStorage && typeof storage !== 'undefined') {
            var timeSync = storage.get('timeSync');
            if (timeSync) return new Date(timeSync);
        }
        return null;
    },
    addObject:        function (objId, obj, callback) {
        if (!this._isConnected) {
            console.log("No connection!");
            return;
        }
        //socket.io
        if (this._socket === null) {
            console.log('socket.io not initialized');
            return;
        }
    },
    delObject:        function (objId) {
        if (!this._checkConnection('delObject', arguments)) return;

        this._socket.emit('delObject', objId);
    },
    httpGet:          function (url, callback) {
        if (!this._isConnected) {
            console.log("No connection!");
            return;
        }
        //socket.io
        if (this._socket === null) {
            console.log('socket.io not initialized');
            return;
        }
        this._socket.emit('httpGet', url, function (data) {
            if (callback) callback(data);
        });
    },
    logError:         function (errorText) {
        console.log("Error: " + errorText);
        if (!this._isConnected) {
            //console.log("No connection!");
            return;
        }
        //socket.io
        if (this._socket === null) {
            console.log('socket.io not initialized');
            return;
        }
        this._socket.emit('log', 'error', 'Addon DashUI  ' + errorText);
    },
    _queueCmdIfRequired: function (func, args) {
        var that = this;
        if (!this._isAuthDone) {
            // Queue command
            this._cmdQueue.push({func: func, args: args});

            if (!this._authRunning) {
                this._authRunning = true;
                // Try to read version
                this._checkAuth(function (version) {
                    // If we have got version string, so there is no authentication, or we are authenticated
                    that._authRunning = false;
                    if (version) {
                        that._isAuthDone  = true;
                        // Repeat all stored requests
                        var __cmdQueue = that._cmdQueue;
                        // Trigger GC
                        that._cmdQueue = null;
                        that._cmdQueue = [];
                        for (var t = 0, len = __cmdQueue.length; t < len; t++) {
                            that[__cmdQueue[t].func].apply(that, __cmdQueue[t].args);
                        }
                    } else {
                        // Auth required
                        that._isAuthRequired = true;
                        // What for AuthRequest from server
                    }
                });
            }

            return true;
        } else {
            return false;
        }
    },
    authenticate:     function (user, password, salt) {
        this._authRunning = true;

        if (user !== undefined) {
            this._authInfo = {
                user: user,
                hash: password + salt,
                salt: salt
            };
        }

        if (!this._isConnected) {
            console.log("No connection!");
            return;
        }

        if (!this._authInfo) {
            console.log("No credentials!");
        }
    },
    getConfig:        function (useCache, callback) {
        if (!this._checkConnection('getConfig', arguments)) return;

        if (typeof useCache === 'function') {
            callback = useCache;
            useCache = false;
        }
        if (this._useStorage && useCache) {
            if (typeof storage !== 'undefined') {
                var objects = storage.get('objects');
                if (objects && objects['system.config']) {
                    return callback(null, objects['system.config'].common);
                }
            } else if (this._objects && this._objects['system.config']) {
                return callback(null, objects['system.config'].common);
            }
        }

        this._socket.emit('getObject', 'system.config', function (err, obj) {
            if (callback && obj && obj.common) {

                if (this._useStorage && typeof storage !== 'undefined') {
                    var objects = storage.get('objects') || {};
                    objects['system.config'] = obj;
                    storage.set('objects', objects);
                }

                callback(null, obj.common);
            } else {
                callback('Cannot read language');
            }
        }.bind(this));
    },
    sendCommand:      function (instance, command, data) {
        this.setState(this.namespace + '.control.instance', {val: instance || 'notdefined', ack: true});
        this.setState(this.namespace + '.control.data',     {val: data,    ack: true});
        this.setState(this.namespace + '.control.command',  {val: command, ack: true});
    },
    _detectViews:     function (projectDir, callback) {
        this.readDir('/' + this.namespace + '/' + projectDir, function (err, dirs) {
            // find vis-views.json
            for (var f = 0; f < dirs.length; f++) {
                if (dirs[f].file == 'vis-views.json' && (!dirs[f].acl || dirs[f].acl.read)) {
                    return callback(err, {name: projectDir, readOnly: (dirs[f].acl && !dirs[f].acl.write), mode: dirs[f].acl ? dirs[f].acl.permissions : 0});
                }
            }
            callback(err);
        });
    },
    readProjects:     function (callback) {
        this.readDir('/' + this.namespace, function (err, dirs) {
            var result = [];
            var count = 0;
            for (var d = 0; d < dirs.length; d++) {
                if (dirs[d].isDir) {
                    count++;
                    this._detectViews(dirs[d].file, function (subErr, project) {
                        if (project) result.push(project);

                        err = err || subErr;
                        if (!(--count)) callback(err, result);
                    });
                }
            }
        }.bind(this));
    },
    chmodProject:     function (projectDir, mode, callback) {
        //socket.io
        if (this._socket === null) {
            console.log('socket.io not initialized');
            return;
        }
        this._socket.emit('chmodFile', this.namespace, projectDir + '*', {mode: mode}, function (err, data) {
            if (callback) callback(err, data);
        });
    },
    clearCache:       function () {
        if (typeof storage !== 'undefined') {
            storage.empty();
        }

    }
};
