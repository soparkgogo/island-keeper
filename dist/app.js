require('source-map-support/register');
var Promise = require('bluebird');
var _ = require('lodash');
var url = require('url');
var Etcd = require('node-etcd');
var IslandKeeper = (function () {
    function IslandKeeper() {
        this._initialized = false;
        this.intervalIds = {};
        if (IslandKeeper.instance) {
            throw new Error("Error: Instantiation failed: Use getInst() instead of new.");
        }
        IslandKeeper.instance = this;
    }
    Object.defineProperty(IslandKeeper.prototype, "initialized", {
        get: function () { return this._initialized; },
        enumerable: true,
        configurable: true
    });
    IslandKeeper.getInst = function () {
        if (!IslandKeeper.instance) {
            IslandKeeper.instance = new IslandKeeper();
        }
        return IslandKeeper.instance;
    };
    IslandKeeper.prototype.init = function (host, port) {
        if (port === void 0) { port = 4001; }
        this.etcd = new Etcd(host, port);
        this._initialized = true;
        return this;
    };
    /**
     * 해당 키로 값을 저장한다.
     * Available options include:
     *  ttl (time to live in seconds)
     *  prevValue (previous value, for compare and swap)
     *  prevExist (existance test, for compare and swap)
     *  prevIndex (previous index, for compare and swap)
     *
     * @param {string} key
     * @param {any} value
     * @param {Object} options
     */
    IslandKeeper.prototype.setKey = function (key, value, options) {
        if (!this._initialized)
            return Promise.reject(new Error('Not initialized exception'));
        if (typeof value !== 'string')
            value = JSON.stringify(value);
        var deferred = Promise.defer();
        this.etcd.set(key, value, options || {}, function (err, res) {
            if (err)
                return deferred.reject(err);
            return deferred.resolve(res);
        });
        return deferred.promise;
    };
    /**
     * 값을 가져온다
     *
     * Available options include:
     *  recursive (bool, list all values in directory recursively)
     *  wait (bool, wait for changes to key)
     *  waitIndex (wait for changes after given index)
     */
    IslandKeeper.prototype.getKey = function (key, options) {
        if (!this._initialized)
            return Promise.reject(new Error('Not initialized exception'));
        var deferred = Promise.defer();
        this.etcd.get(key, options || {}, function (err, res) {
            if (err)
                return deferred.reject(err);
            return deferred.resolve(res);
        });
        return deferred.promise;
    };
    /**
     * 키를 삭제한다
     *
     * Available options include:
     *  recursive (bool, delete recursively)
     */
    IslandKeeper.prototype.delKey = function (key, options) {
        if (!this._initialized)
            return Promise.reject(new Error('Not initialized exception'));
        var deferred = Promise.defer();
        this.etcd.del(key, options || {}, function (err, res) {
            if (err)
                return deferred.reject(err);
            return deferred.resolve(res);
        });
        return deferred.promise;
    };
    /**
     * 디렉토리를 생성한다. setKey와 유사하지만 value 를 지정하지 않는다
     */
    IslandKeeper.prototype.mkdir = function (dir, options) {
        if (!this._initialized)
            return Promise.reject(new Error('Not initialized exception'));
        var deferred = Promise.defer();
        this.etcd.mkdir(dir, options || {}, function (err, res) {
            if (err)
                return deferred.reject(err);
            return deferred.resolve(res);
        });
        return deferred.promise;
    };
    /**
     * 디렉토리를 삭제한다. delKey와 유사함
     */
    IslandKeeper.prototype.rmdir = function (dir, options) {
        if (!this._initialized)
            return Promise.reject(new Error('Not initialized exception'));
        var deferred = Promise.defer();
        this.etcd.rmdir(dir, options || {}, function (err, res) {
            if (err)
                return deferred.reject(err);
            return deferred.resolve(res);
        });
        return deferred.promise;
    };
    /**
     * watcher 를 리턴한다. recursive 옵션이 켜 있는 경우 하위 키에 대한 변경된 부분만 전달된다
     *
     * Signals:
     *  change - emitted on value change
     *  reconnect - emitted on reconnect
     *  error - emitted on invalid content
     *  <etcd action> - the etcd action that triggered the watcher (ex: set, delete).
     *  stop - watcher was canceled.
     *  resync - watcher lost sync (server cleared and outdated the index).
     */
    IslandKeeper.prototype.getWatcher = function (key, options) {
        if (!this._initialized)
            throw new Error('Not initialized exception');
        return this.etcd.watcher(key, null, options);
    };
    /**
     * node 를 파싱한다
     */
    IslandKeeper.parseNode = function (node) {
        var _this = this;
        if (!node)
            return;
        var obj = {};
        var key = _.last(node.key.split('/'));
        if (node.dir && Array.isArray(node.nodes)) {
            node.nodes.forEach(function (node) {
                var parsed = _this.parseNode(node);
                if (key) {
                    if (!obj[key])
                        obj[key] = {};
                    _.merge(obj[key], parsed);
                }
                else
                    _.merge(obj, parsed);
            });
        }
        else {
            if (/^\d+$/.test(node.value))
                obj[key] = parseInt(node.value, 10);
            else {
                try {
                    obj[key] = JSON.parse(node.value);
                }
                catch (e) {
                    obj[key] = node.value;
                }
            }
        }
        return obj;
    };
    IslandKeeper.prototype.getIsland = function (name) {
        return this.getKey(['/islands/hosts', name].join('/'), { recursive: true }).then(function (res) {
            var node = IslandKeeper.parseNode(res.node);
            return (node[name]) ? node[name] : node;
        }).catch(function (err) {
            // not found
            if (err.errorCode === 100)
                return {};
            throw err;
        });
    };
    IslandKeeper.prototype.getIslands = function () {
        return this.getKey('/islands', { recursive: true }).then(function (res) {
            var node = IslandKeeper.parseNode(res.node);
            return (node['islands'] ? node['islands'] : {});
        }).catch(function (err) {
            // not found
            if (err.errorCode === 100)
                return {};
            throw err;
        });
    };
    IslandKeeper.prototype.watchIslands = function (handler) {
        if (!this._initialized)
            throw new Error('Not initialized exception');
        var islands = {};
        var watcher = this.getWatcher('/islands', { recursive: true });
        var _handler = function (res) {
            var key = res.node.key.replace(/\/islands\//, '').replace(/\//g, '.');
            if (res.action === 'expire' || res.action === 'delete') {
                islands = _.set(islands, key, undefined);
            }
            else {
                var value = IslandKeeper.parseNode(res.node);
                var splits = key.split('.');
                islands = _.set(islands, key, value[splits[splits.length - 1]]);
            }
            return handler(islands);
        };
        watcher.on('change', _handler);
        watcher.on('set', _handler);
        watcher.on('delete', _handler);
        watcher.on('update', _handler);
        watcher.on('create', _handler);
        watcher.on('expire', _handler);
        this.getIslands().then(function (result) {
            islands = result;
            return handler(result);
        });
        return watcher;
    };
    IslandKeeper.prototype.registerIsland = function (name, value, options) {
        var _this = this;
        if (options === void 0) { options = {}; }
        var register = function () {
            return Promise.try(function () {
                var key = 's' + value.hostname.replace(/\./g, '') + value.port;
                return Promise.all([
                    _this.setKey(['/islands', 'hosts', name, key].join('/'), url.format({
                        protocol: value.protocol || 'http',
                        hostname: value.hostname,
                        port: value.port
                    }), { ttl: options.ttl || 10 }),
                    _this.setKey(['/islands', 'patterns', name].join('/'), value.pattern), { ttl: options.ttl || 10 }
                ]);
            });
        };
        return Promise.try(function () {
            if (_this.intervalIds[name])
                throw new Error('Duplicated name');
            _this.intervalIds[name] = setInterval(function () { return register(); }, options.interval || 5000);
            return register();
        });
    };
    IslandKeeper.prototype.unregisterIsland = function (name) {
        var _this = this;
        return Promise.try(function () {
            if (!_this.intervalIds[name])
                throw new Error('Missing name');
            var id = _this.intervalIds[name];
            clearInterval(id);
            delete _this.intervalIds[name];
            return Promise.all([
                _this.delKey('/islands/hosts/' + name, { recursive: true }),
                _this.delKey('/islands/patterns/' + name, { recursive: true })
            ]);
        });
    };
    IslandKeeper.prototype.registerEndpoint = function (name, value, options) {
        // name: GET@|players|:pid
        var key = ['/endpoints', name].join('/');
        return this.setKey(key, value);
    };
    IslandKeeper.prototype.getEndpoints = function () {
        return this.getKey('/endpoints', { recursive: true }).then(function (res) {
            var node = IslandKeeper.parseNode(res.node);
            return node['endpoints'] ? node['endpoints'] : {};
        }).catch(function (err) {
            // NOTE: 키가 존재하지 않는다면 언젠가 set 되므로 watchEndpoints 에서 키를 등록하게 될 것이다
            if (err.errorCode === 100)
                return {};
            throw err;
        });
    };
    IslandKeeper.prototype.deleteEndpoints = function () {
        return this.delKey('/endpoints', { recursive: true });
    };
    IslandKeeper.prototype.watchEndpoints = function (handler) {
        if (!this._initialized)
            throw new Error('Not initialized exception');
        var watcher = this.getWatcher('/endpoints', { recursive: true });
        var _handler = function (res) {
            var splits = res.node.key.split('/');
            return handler(res.action, splits[2], IslandKeeper.parseNode(res.node)[splits[2]]);
        };
        watcher.on('create', _handler);
        watcher.on('set', _handler);
        watcher.on('update', _handler);
        watcher.on('change', _handler);
        return watcher;
    };
    return IslandKeeper;
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = IslandKeeper;
//# sourceMappingURL=app.js.map