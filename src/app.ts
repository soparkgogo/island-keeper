import 'source-map-support/register'
import * as Promise from 'bluebird';
import * as _ from 'lodash';
import * as events from 'events';
import * as url from 'url';
var Etcd = require('node-etcd');

export interface INode {
  key: string;
  value?: string; // 디렉토리를 생성하거나 키를 삭제하는 경우 value가 없을 수도 있다
  createdIndex?: number;
  modifiedIndex?: number;
  expiration?: Date;
  ttl?: number;
  dir?: boolean; // 하위 node가 있는경우 true
  nodes?: INode[];
}

export interface IResponse {
  action: string; // 'get', 'set', 'delete', 'update', 'compareAndSwap', 'expire'
  node: INode;
  prevNode?: INode;
}

export interface Islands {
  patterns?: { [serviceName: string]: string };
  hosts?: {
    [serviceName: string]: {
      [hostname: string]: string
    }
  }
}

export default class IslandKeeper {
  private static instance: IslandKeeper;

  private etcd: any;
  private _initialized: boolean = false;
  private intervalIds: { [name: string]: any } = {};

  public get initialized() { return this._initialized; }

  constructor() {
    if (IslandKeeper.instance) {
      throw new Error("Error: Instantiation failed: Use getInst() instead of new.");
    }
    IslandKeeper.instance = this;
  }

  public static getInst(): IslandKeeper {
    if (!IslandKeeper.instance) {
      IslandKeeper.instance = new IslandKeeper();
    }
    return IslandKeeper.instance;
  }

  public init(host: string, port: number = 4001) {
    this.etcd = new Etcd(host, port);
    this._initialized = true;
    return this;
  }

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
  public setKey(key: string, value: any, options?: { ttl?: number, prevValue?: any, prevExist?: boolean, prevIndex?: number, maxRetries?: number }) {
    if (!this._initialized) return Promise.reject<IResponse>(new Error('Not initialized exception'));
    if (typeof value !== 'string') value = JSON.stringify(value);
    var deferred = Promise.defer<IResponse>();
    this.etcd.set(key, value, options || {}, (err, res: IResponse) => {
      if (err) return deferred.reject(err);
      return deferred.resolve(res);
    });
    return deferred.promise;
  }

  /**
   * 값을 가져온다
   *
   * Available options include:
   *  recursive (bool, list all values in directory recursively)
   *  wait (bool, wait for changes to key)
   *  waitIndex (wait for changes after given index)
   */
  public getKey(key: string, options?: { recursive?: boolean, wait?: boolean, waitIndex?: number }) {
    if (!this._initialized) return Promise.reject<IResponse>(new Error('Not initialized exception'));
    var deferred = Promise.defer<IResponse>();
    this.etcd.get(key, options || {}, (err, res: IResponse) => {
      if (err) return deferred.reject(err);
      return deferred.resolve(res);
    });
    return deferred.promise;
  }

  /**
   * 키를 삭제한다
   *
   * Available options include:
   *  recursive (bool, delete recursively)
   */
  public delKey(key: string, options?: { recursive?: boolean }) {
    if (!this._initialized) return Promise.reject<IResponse>(new Error('Not initialized exception'));
    var deferred = Promise.defer<IResponse>();
    this.etcd.del(key, options || {}, (err, res: IResponse) => {
      if (err) return deferred.reject(err);
      return deferred.resolve(res);
    });
    return deferred.promise;
  }

  /**
   * 디렉토리를 생성한다. setKey와 유사하지만 value 를 지정하지 않는다
   */
  public mkdir(dir: string, options?: any) {
    if (!this._initialized) return Promise.reject<IResponse>(new Error('Not initialized exception'));
    var deferred = Promise.defer<IResponse>();
    this.etcd.mkdir(dir, options || {}, (err, res: IResponse) => {
      if (err) return deferred.reject(err);
      return deferred.resolve(res);
    });
    return deferred.promise;
  }

  /**
   * 디렉토리를 삭제한다. delKey와 유사함
   */
  public rmdir(dir: string, options?: { recursive?: boolean }) {
    if (!this._initialized) return Promise.reject<IResponse>(new Error('Not initialized exception'));
    var deferred = Promise.defer<IResponse>();
    this.etcd.rmdir(dir, options || {}, (err, res: IResponse) => {
      if (err) return deferred.reject(err);
      return deferred.resolve(res);
    });
    return deferred.promise;
  }

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
  public getWatcher(key, options?: { recursive?: boolean }): events.EventEmitter {
    if (!this._initialized) throw new Error('Not initialized exception');
    return this.etcd.watcher(key, null, options);
  }

  /**
   * node 를 파싱한다
   */
  public static parseNode(node: INode) {
    if (!node) return;
    var obj = {};
    var key = _.last<string>(node.key.split('/'));
    if (node.dir && Array.isArray(node.nodes)) {
      node.nodes.forEach(node => {
        let parsed = this.parseNode(node);
        if (key) {
          if (!obj[key]) obj[key] = {};
          _.merge(obj[key], parsed);
        } else _.merge(obj, parsed);
      });
    } else {
      if (/^\d+$/.test(node.value)) obj[key] = parseInt(node.value, 10);
      else {
        try { obj[key] = JSON.parse(node.value); } catch (e) { obj[key] = node.value; }
      }
    }
    return obj;
  }

  public getIsland(name: string): Promise<{[host: string]: string}> {
    return this.getKey(['/islands/hosts', name].join('/'), { recursive: true }).then(res => {
      var node = IslandKeeper.parseNode(res.node);
      return (node[name]) ? node[name] : node;
    }).catch(err => {
      // not found
      if (err.errorCode === 100) return <{[host: string]: string}>{};
      throw err;
    });
  }

  public getIslands(): Promise<Islands> {
    return this.getKey('/islands', { recursive: true }).then(res => {
      var node = IslandKeeper.parseNode(res.node);
      return <Islands>(node['islands'] ? node['islands'] : {});
    }).catch(err => {
      // not found
      if (err.errorCode === 100) return <Islands>{};
      throw err;
    });
  }

  public watchIslands(handler: (islands: Islands) => void) {
    if (!this._initialized) throw new Error('Not initialized exception');

    let islands: Islands = {};
    var watcher = this.getWatcher('/islands', { recursive: true });
    var _handler = (res: IResponse) => {
      let key = res.node.key.replace(/\/islands\//, '').replace(/\//g, '.');
      if (res.action === 'expire' || res.action === 'delete') {
        islands = _.set(islands, key, undefined);
      } else {
        let value = IslandKeeper.parseNode(res.node);
        let splits = key.split('.');
        islands = _.set(islands, key, value[splits[splits.length - 1]]);
      }
      return handler(islands);
    }
    watcher.on('change', _handler);
    watcher.on('set', _handler);
    watcher.on('delete', _handler);
    watcher.on('update', _handler);
    watcher.on('create', _handler);
    watcher.on('expire', _handler);

    this.getIslands().then(result => {
      islands = result;
      return handler(result);
    });
    return watcher;
  }

  public registerIsland(name: string, value: { hostname: string, port: any, pattern?: string, protocol?: string }, options: { ttl?: number, interval?: number } = {}) {
    let register = () => {
      return Promise.try(() => {
        let key = 's' + value.hostname.replace(/\./g, '') + value.port;
        return Promise.all([
          this.setKey(['/islands', 'hosts', name, key].join('/'), url.format({
            protocol: value.protocol || 'http',
            hostname: value.hostname,
            port: value.port
          }), { ttl: options.ttl || 10 }),
          this.setKey(['/islands', 'patterns', name].join('/'), value.pattern), { ttl: options.ttl || 10 }
        ]);
      });
    }

    return Promise.try(() => {
      if (this.intervalIds[name]) throw new Error('Duplicated name');

      this.intervalIds[name] = setInterval(() => register(), options.interval || 5000);
      return register();
    });
  }

  public unregisterIsland(name: string) {
    return Promise.try(() => {
      if (!this.intervalIds[name]) throw new Error('Missing name');

      var id = this.intervalIds[name];
      clearInterval(id);
      delete this.intervalIds[name];

      return Promise.all([
        this.delKey('/islands/hosts/' + name, { recursive: true }),
        this.delKey('/islands/patterns/' + name, { recursive: true })
      ]);
    });
  }

  public registerEndpoint(name: string, value: any, options?: { ttl?: number }) {
    // name: GET@|players|:pid
    var key = ['/endpoints', name].join('/');
    return this.setKey(key, value);
  }

  public getEndpoints<T>() {
    return this.getKey('/endpoints', { recursive: true }).then(res => {
      var node = IslandKeeper.parseNode(res.node);
      return node['endpoints'] ? node['endpoints'] : {};
    }).catch(err => {
      // NOTE: 키가 존재하지 않는다면 언젠가 set 되므로 watchEndpoints 에서 키를 등록하게 될 것이다
      if (err.errorCode === 100) return <T>{};
      throw err;
    });
  }

  public deleteEndpoints() {
    return this.delKey('/endpoints', { recursive: true });
  }

  public watchEndpoints<T>(handler: (action: string, name: string, value: T) => void) {
    if (!this._initialized) throw new Error('Not initialized exception');

    let watcher = this.getWatcher('/endpoints', { recursive: true });
    let _handler = (res: IResponse) => {
      var splits = res.node.key.split('/');
      return handler(res.action, splits[2], <T>IslandKeeper.parseNode(res.node)[splits[2]]);
    }

    watcher.on('create', _handler);
    watcher.on('set', _handler);
    watcher.on('update', _handler);
    watcher.on('change', _handler);
    return watcher;
  }
}