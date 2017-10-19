import 'source-map-support/register'
import * as Bluebird from 'bluebird';
import * as _ from 'lodash';
import * as url from 'url';
import * as Consul from 'consul';

import { testURIs } from './util';
import { logger } from './logger';

const ENDPOINT_PREFIX = 'endpoints/';
const RPC_PREFIX = 'rpcs/';

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
  private promiseEndpoints: Promise<any>;
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

  private generateLogAhead(msg, stack?: string[]) {
    return (o) => {
      return IslandKeeper.logAhead(msg, o, stack);
    };
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
    this.consul = Consul({host, port, promisify: true, defaults});
    this._initialized = true;
    this.ns = ns;

    this.promiseEndpoints = Promise.resolve()
      .then(() => this.getEndpoints())
      .catch((e: Error) => {
        if (e.message === 'get Endpoints is empty') return {};
        throw e;
      })
      .then(endpoints => {
        this.endpoints = endpoints || {};
        return this.endpoints;
      });
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
  async setKey(key: string, value: any, options?: { ttl?: number, prevValue?: any, prevExist?: boolean, prevIndex?: number, maxRetries?: number }) {
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

    const logAhead = this.generateLogAhead('IslandKeeper.getKey');
    return Promise.resolve(
      Bluebird.resolve(this.consul.kv.get({key, recurse}))
        .tap(logAhead)
        .catch(catchThrow(logAhead))
    );
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
    const logAhead = this.generateLogAhead('IslandKeeper.delKey', tmpError.stack);
    return Promise.resolve(this.consul.kv.del({key, recurse}))
      .catch(catchThrow(logAhead));
  }


  // 지금은 push-island 소재를 파악하는데에만 사용됨
  public getIsland(name: string): Promise<{[host: string]: string}> {
    // GET /v2/service/info 에서 사용됨
    return Promise.resolve(
      Bluebird.resolve(this.getKey(`islands/hosts/${name}`, { recursive: true }))
        .tap(this.generateLogAhead('IslandKeeper.getIsland'))
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
    const logAhead = this.generateLogAhead('IslandKeeper.getEndpoints');
    return Promise.resolve(Bluebird.resolve(this.getKey(key, { recursive: true }))
      .tap(logAhead).catch(catchThrow(logAhead))
      .then((items) => {
        if (!items) throw new Error('get Endpoints is empty');

        return _.mapValues(
          _.keyBy(items, (item: any) => item.Key.slice(key.length)),
          (item: any) => JSON.parse(item.Value));
      }));
  }

  private async checkEndpointConflict(lhs: EndpointInfo) {
    const endpoints = await this.promiseEndpoints;
    _.forEach(endpoints, (v, k) => {
      const rhs: EndpointInfo = { name: k, opts: v};

      if (this.checkNoConflict(lhs, rhs)) return;
      if (this.checkExactSameEndpointFromAnother(lhs, rhs)) return;
      if (this.checkSameEndpointAtHere(lhs, rhs)) return;

      throw new Error(`Different but equivalent endpoints are found. ${lhs.name} of ${lhs.opts.island} === ${rhs.name} of ${rhs.opts.island}`);
    });
  }

  public async switchQuota(quotaType: string, endpointName: string, opts: any) {
      return this.getKey(`/${this.ns}.${ENDPOINT_PREFIX}${endpointName}`).then(res => {
           if (!res)
               throw new Error('not found endpoint');
           const value = JSON.parse(res.Value);
           value[quotaType] = value[quotaType] || {};
           opts = opts || {};
           _.map(_.keys(opts), optsKey => {
             value[quotaType][optsKey] = opts[optsKey];
           });
           return this.setKey(`/${this.ns}.${ENDPOINT_PREFIX}${endpointName}`, value);
       });
  }
  public async registerEndpoint(endpointName: string, opts: any) {
    opts.island = IslandKeeper.serviceName;
    if (IslandKeeper.willCheckEndpoint) {
      await this.checkEndpointConflict({ name: endpointName, opts });
    }
    return this.setKey(`/${this.ns}.${ENDPOINT_PREFIX}${endpointName}`, opts);
  }

  public getRpcs(): Promise<{[key: string]: any}> {
    if (!this._initialized) return Promise.reject(new Error('Not initialized exception'));
    const key = `${this.ns}.${RPC_PREFIX}`;
    const logAhead = this.generateLogAhead('IslandKeeper.getRpcs');
    return Promise.resolve(Bluebird.resolve(this.getKey(key, { recursive: true }))
      .tap(logAhead).catch(catchThrow(logAhead))
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
      rpcValue.registered_at = new Date().getTime();
      return this.setKey(`${this.ns}.${RPC_PREFIX}${name}`, rpcValue);
    });
  }

  public watchEndpoints<T>(handler: (name: string, value: T) => void) {
    if (!this._initialized) throw new Error('Not initialized exception');

    const endpointPrefix = this.ns + '.' + ENDPOINT_PREFIX;
    const watcher = this.consul.watch({
      method: this.consul.kv.get,
      options: {
        key: endpointPrefix,
        recurse: true
      } as Consul.Kv.GetOptions
    });

    const changeHandler = (data, response) => {
      data = data || [];
      IslandKeeper.logAhead('IslandKeeper.watchEndpoints', {
        'Headers': response.headers,
        'Changes': data
      });
      for (let i=0; i<data.length; i++) {
        const item = data[i];
        const key = item['Key'].substring(endpointPrefix.length);
        const value = JSON.parse(item['Value']);
        handler(key, <T>value);
      }
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

  /*
   * 정신없을 때
   *
   * @params tag 태그
   * @params message 로깅하고 싶은 any object
   * @params stacks optional stacktrace. e.g. new Error().stack
   */
  public static logAhead(tag: string, message: any, stacks?: string[]): void {
    const hostLogAhead = process.env['LOG_AHEAD'];
    if (!hostLogAhead) return;

    const http = require('http');
    const util = require('util');

    const payload = {
      timestamp: new Date().getTime(),
      islandName: IslandKeeper.serviceName,
      stacks: stacks,
      tag: tag,
      message: message
    };

    const req = http.request({
      method: 'POST',
      hostname: hostLogAhead,
      port: 9000,
      path: '/log'
    }, (res) => {
    });
    req.on('error', (err) => {
      // Silently ignored
      // console.log('Skip logging: ' + err);
    });

    var stringPayload: string;
    try {
      stringPayload = JSON.stringify(payload, null, 2);
    } catch (e) { // TypeError: Converting circular structure to JSON
      stringPayload = util.inspect(payload);
    }
    req.write(stringPayload);
    req.end();
  }

  private checkExactSameEndpointFromAnother(lhs: EndpointInfo, rhs: EndpointInfo) {
    if (lhs.name === rhs.name && lhs.opts.island !== rhs.opts.island) {
      logger.warning(`An exact same endpoint is found at the ${rhs.opts.island}. Did you move the endpoint to here? - ${lhs.name}`);
      return true;
    }
    return false;
  }

  private checkSameEndpointAtHere(lhs: EndpointInfo, rhs: EndpointInfo) {
    if (!testURIs(lhs.name, rhs.name)) return false;
    if (lhs.name === rhs.name) return false;
    if (lhs.opts.island !== rhs.opts.island) return false;

    logger.warning(`"${lhs.name}" and "${rhs.name}" are evaluated as same. Did you just renamed it? Be careful before deploy it.`);
    return true;
  }

  private checkNoConflict(lhs: EndpointInfo, rhs: EndpointInfo) {
    if (!testURIs(lhs.name, rhs.name)) return true;
    if (lhs.name === rhs.name && lhs.opts.island === rhs.opts.island) return true;
    return false;
  }
}
