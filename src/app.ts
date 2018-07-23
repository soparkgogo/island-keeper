import 'source-map-support/register'
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as url from 'url';
import * as Consul from 'consul';
import * as Crypto from 'crypto';

import { replaceUri } from './util';
import { logger } from './logger';

const ENDPOINT_PREFIX = 'endpoints/';
const RPC_PREFIX = 'rpcs/';
const CHECKSUM_PREFIX = 'checksum/';
const WATCH_PREFIX = 'watch/';

export interface Islands {
  patterns?: { [serviceName: string]: string };
  hosts?: {
    [serviceName: string]: {
      [hostname: string]: string
    }
  }
}

export interface InitArgument {
  host: string;
  port?: string;
  ns?: string;
  token?: string;
}

// http://bluebirdjs.com/docs/api/catchthrow.html
// 빨리 bluebird 3.0으로 갔으면... @kson //2016-08-08
// 오히려 bluebird를 제거해버렸다. 크흑 @kson //2016-11-14
function catchThrow(fn) {
  return (e) => {
    fn(e);
    throw e;
  };
}

interface EndpointInfo {
  name: string;
  opts: { island: string };
}

export default class IslandKeeper {
  private static instance: IslandKeeper;
  private static serviceName: string;
  private static willCheckEndpoint: boolean = process.env.ISLAND_KEEPER_ENDPOINT_CHECK === 'true';
  private static watcherErrorLimitCount: number = parseInt(process.env.ISLAND_WATCH_LIMIT || 10, 10);

  private ns: string;
  private consul: Consul.Consul;
  private _initialized: boolean = false;
  private intervalIds: { [name: string]: any } = {};
  private endpoints: any = {};
  private watchErrorCount = 0;

  public get initialized() { return this._initialized; }

  constructor() {
    if (IslandKeeper.instance) {
      throw new Error('Error: Instantiation failed: Use getInst() instead of new.');
    }
    IslandKeeper.instance = this;
  }

  public static getInst(): IslandKeeper {
    if (!IslandKeeper.instance) {
      IslandKeeper.instance = new IslandKeeper();
    }
    return IslandKeeper.instance;
  }

  public static enableEndpointCheck(value: boolean) {
    IslandKeeper.willCheckEndpoint = value;
  }

  public init({
    host = 'consul',
    port,
    ns = 'game',
    token = process.env.ISLAND_CONSUL_TOKEN
  }: InitArgument) {
    const defaults: {token?: string} = {
      token
    };
    logger.info(`connection info: consul ${host}:${port}`);
    this.consul = Consul({host, port, promisify: true, defaults});
    this._initialized = true;
    this.ns = ns;
  }

  public setServiceName(name: string) {
    IslandKeeper.serviceName = name;
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
  async setKey(key: string, value: any, options?: { ttl?: number, prevValue?: any, prevExist?: boolean, prevIndex?: number, maxRetries?: number, cas?: string}) {
    if (!this._initialized) return Promise.reject(new Error('Not initialized exception'));
    if (typeof value !== 'string') value = JSON.stringify(value);

    if (key && key.length > 1 && key[0] == '/') {
      key = key.slice(1);
    }

    let input = { key, value } as any;
    let sid;

    // Need to create a new session when it needs ttl function.
    if (options && options.ttl) {
      let check: any = await this.consul.kv.get({ key });

      if (!check || !check.Session) {    // To Create a new session
        const session: any = await this.consul.session.create({ name: key, ttl: options.ttl.toString() + 's', behavior: "delete" });
        sid = session.ID;
      }
      else {    // To Update an old session
        sid = check.Session;
        this.consul.session.renew(sid);
      }

      input.acquire = sid;    // Leave sid property in the input parameter for ttl function.
    }

    if (options && options.cas) {
      input.cas = options.cas;
    }

    return Promise.resolve(this.consul.kv.set(input));
  }

  /**
   * 값을 가져온다
   *
   * Available options include:
   *  recursive (bool, list all values in directory recursively)
   *  사용되지 않음 wait (bool, wait for changes to key)
   *  사용되지 않음 waitIndex (wait for changes after given index)
   */
  public getKey(key: string, options?: { recursive?: boolean, wait?: boolean, waitIndex?: number }): Promise<any> {
    if (!this._initialized) return Promise.reject(new Error('Not initialized exception'));
    if (key && key.length > 1 && key[0] === '/') {
      key = key.slice(1);
    }
    const recurse = options && options.recursive || false;

    return Promise.resolve(Bluebird.resolve(this.consul.kv.get({key, recurse})));
  }

  /**
   * 키를 삭제한다
   *
   * Available options include:
   *  recursive (bool, delete recursively)
   */
  async delKey(key: string, options?: { recursive?: boolean }) {
    if (!this._initialized) return Promise.reject(new Error('Not initialized exception'));
    const recurse = options && options.recursive || false;

    // destroy the key with TTL function
    const result: any = await this.consul.kv.get({key, recurse});
    if (result && result.Session) {
      return await this.consul.session.destroy(result.Session);
    }

    const tmpError = new Error() as any;
    return Promise.resolve(this.consul.kv.del({key, recurse}));
  }


  // 지금은 push-island 소재를 파악하는데에만 사용됨
  public getIsland(name: string): Promise<{[host: string]: string}> {
    // GET /v2/service/info 에서 사용됨
    return Promise.resolve(
      Bluebird.resolve(this.getKey(`islands/hosts/${name}`, { recursive: true }))
        .catch(err => {
          // not found
          if (err.errorCode === 100) return {};
          throw err;
        })
    );
  }

  // 지금은 push-island를 등록하는데에만 사용됨
  public registerIsland(name: string, value: { hostname: string, port: any, pattern?: string, protocol?: string },
                        options: { ttl?: number, interval?: number } = {}) {
    const register = () => {
      return Bluebird.try(() => {
        const key = 's' + value.hostname.replace(/\./g, '') + value.port;
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

    return Promise.resolve(
      Bluebird.try(() => {
      if (this.intervalIds[name]) throw new Error('Duplicated name');

      this.intervalIds[name] = setInterval(() => register(), options.interval || 5000);
      return register();
    }));
  }

public unregisterIsland(name: string, value: { hostname: string, port: any, pattern?: string, protocol?: string }) {
    return Promise.resolve(Bluebird.try(() => {
      if (!this.intervalIds[name]) throw new Error('Missing name');

      var id = this.intervalIds[name];
      clearInterval(id);
      delete this.intervalIds[name];

      const key = 's' + value.hostname.replace(/\./g, '') + value.port;
      return Promise.all([
        this.delKey(['islands', 'hosts', name, key].join('/'), { recursive: true }),
        this.delKey(['islands', 'patterns', name].join('/'), { recursive: true })
      ]);
    }));
  }

  public getEndpoints<T>() {
    if (!this._initialized) return Promise.reject(new Error('Not initialized exception'));

    const key = `${this.ns}.${ENDPOINT_PREFIX}`;
    return Promise.resolve(Bluebird.resolve(this.getKey(key, { recursive: true }))
      .then((items) => {
        if (!items) return {};

        return _.mapValues(
          _.keyBy(items, (item: any) => item.Key.slice(key.length)),
          (item: any) => JSON.parse(item.Value));
      }));
  }

  public async switchQuota(quotaType: string, endpointName: string, opts: any) {
      return this.getKey(`${this.ns}.${ENDPOINT_PREFIX}${endpointName}`).then(res => {
           if (!res)
               throw new Error('not found endpoint');
           const value = JSON.parse(res.Value);
           value[quotaType] = value[quotaType] || {};
           opts = opts || {};
           _.map(_.keys(opts), optsKey => {
             value[quotaType][optsKey] = opts[optsKey];
           });
           return this.setKey(`${this.ns}.${ENDPOINT_PREFIX}${endpointName}`, value);
       });
  }

  public registerEndpoint(endpointName: string, opts: any) {
    opts = opts || {};
    opts.island = IslandKeeper.serviceName;
    opts.checksum = this.checksum(opts);
    this.endpoints[endpointName] = opts;
  }

  public async saveEndpoint() {
    const islandCheckSum = this.checksum(this.endpoints || {});
    const orgChecksum = await this.getEnpointChecksum();
    const ModifyIndex = (orgChecksum.ModifyIndex || '').toString() || undefined;
    if (orgChecksum.Value === islandCheckSum) {
      return;
    }
    await this.checkEndpointConflict();
    if (!await this.setIslandChecksum(this.getIslandChecksumKey(), islandCheckSum, ModifyIndex)) {
      return;
    }
    await Promise.all(_.map(this.endpoints, async (opts, name) => {
      if (opts.status === 'del') {
        await this.delKey(`${this.ns}.${ENDPOINT_PREFIX}${name}`, { recursive: true });
      } else if (opts.status !== 'unchanged') {
        await this.setKey(`${this.ns}.${ENDPOINT_PREFIX}${name}`, _.omit(opts, ['status']));
      }
    }));
    this.setKey(this.getEndpointWatchKey(), +new Date());
  }

  public getRpcs(): Promise<{[key: string]: any}> {
    if (!this._initialized) return Promise.reject(new Error('Not initialized exception'));
    const key = `${this.ns}.${RPC_PREFIX}`;
    return Promise.resolve(Bluebird.resolve(this.getKey(key, { recursive: true }))
      .then((items) => {
        if (!items) throw new Error('get Endpoints is empty');

        return _.mapValues(
          _.keyBy(items, (item: any) => item.Key.slice(key.length)),
          (item: any) => JSON.parse(item.Value));
      }));
  }

  public registerRpc(name: string, value: any) {
    const currentIsland: string = IslandKeeper.serviceName;
    const rpcValue = value || {};

    if (!currentIsland || currentIsland === undefined || currentIsland === 'undefined')
      throw new Error("IslandKeeper will NOT register RPCs that doesn't provide its origin island. You should use IslandKeeper.setServiceName(string) at the very beginning");

    return this.getKey(`${this.ns}.${RPC_PREFIX}${name}`).then(res => {
      // Consul은 key not found 일 때, result가 undefined 임
      if (res) {
        const prevIsland = JSON.parse(res.Value).island;
        if (prevIsland != currentIsland) {
          throw new Error(`# RPC(${this.ns}.${name}) is already registered by ${prevIsland}-island.`);
        }
      }
      rpcValue.island = currentIsland;
      rpcValue.registered_at = +new Date();
      return this.setKey(`${this.ns}.${RPC_PREFIX}${name}`, rpcValue);
    });
  }

  public watchEndpoints<T>(handler: (endpoints: any) => void) {
    if (!this._initialized) throw new Error('Not initialized exception');

    const endpointPrefix = this.getEndpointWatchKey();
    const watcher = this.consul.watch({
      method: this.consul.kv.get,
      options: {
        key: endpointPrefix,
        recurse: true
      } as Consul.Kv.GetOptions
    });

    const changeHandler = async (data, response) => {
      data = data || '';
      if (!data) {
        this.setKey(endpointPrefix, +new Date());
        return;
      }
      handler(await this.getEndpoints());
      this.watchErrorCount = 0;
    };
    watcher.on('change', changeHandler);
    watcher.on('error', async err => {
      try {
        await watcher.end();
      } catch(err1) {}

      if (++this.watchErrorCount > IslandKeeper.watcherErrorLimitCount) {
        throw err;
      }
      this.watchEndpoints(handler);
    })
    return watcher;
  }

  private getIslandChecksumKey() {
    return `${this.ns}.${CHECKSUM_PREFIX}${ENDPOINT_PREFIX}${IslandKeeper.serviceName}`;
  }

  private getEndpointWatchKey() {
    return `${this.ns}.${WATCH_PREFIX}endpoint`;
  }
  private checksum(obj: any, algorithm?: string, encoding?: Crypto.HexBase64Latin1Encoding) {
    const str = JSON.stringify(_(obj).toPairs().sortBy(0).fromPairs().value());
    return Crypto.createHash(algorithm || 'md5').update(str, 'utf8').digest(encoding || 'hex');
  }

  private getEnpointChecksum() {
    return this.getKey(this.getIslandChecksumKey()).then(res => res || {});
  }

  private async setIslandChecksum(key: string, value: string, cas?: string): Promise<boolean> {
    return !!(await this.setKey(key, value, {cas}));
  }

  private async checkEndpointConflict() {
    const endpoints = await this.getEndpoints();
    const endpointReplaceNames = _(this.endpoints).keys().map(name => [replaceUri(name)]).fromPairs().value();

    _.forEach(endpoints, (opts, name) => {
      if (opts['island'] === IslandKeeper.serviceName) {
        if (!this.endpoints[name]) {
          this.endpoints[name] = {'status': 'del'};
        } else if (opts['checksum'] === this.endpoints[name].checksum) {
          this.endpoints[name].status = 'unchanged';
        }
      } else {
        if (endpointReplaceNames.hasOwnProperty(replaceUri(name))) {
          throw new Error(`Different but equivalent endpoints are found. ${name} of ${opts['island']} === ${endpointReplaceNames[replaceUri(name)]}`);
        }
      }
    })
  }
}
