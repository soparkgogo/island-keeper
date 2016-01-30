import * as Promise from 'bluebird';
import * as events from 'events';
export interface INode {
    key: string;
    value?: string;
    createdIndex?: number;
    modifiedIndex?: number;
    expiration?: Date;
    ttl?: number;
    dir?: boolean;
    nodes?: INode[];
}
export interface IResponse {
    action: string;
    node: INode;
    prevNode?: INode;
}
export interface Islands {
    patterns?: {
        [serviceName: string]: string;
    };
    hosts?: {
        [serviceName: string]: {
            [hostname: string]: string;
        };
    };
}
export default class IslandKeeper {
    private static instance;
    private etcd;
    private _initialized;
    private intervalIds;
    initialized: boolean;
    constructor();
    static getInst(): IslandKeeper;
    init(host: string, port?: number): IslandKeeper;
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
    setKey(key: string, value: any, options?: {
        ttl?: number;
        prevValue?: any;
        prevExist?: boolean;
        prevIndex?: number;
        maxRetries?: number;
    }): Promise<IResponse>;
    /**
     * 값을 가져온다
     *
     * Available options include:
     *  recursive (bool, list all values in directory recursively)
     *  wait (bool, wait for changes to key)
     *  waitIndex (wait for changes after given index)
     */
    getKey(key: string, options?: {
        recursive?: boolean;
        wait?: boolean;
        waitIndex?: number;
    }): Promise<IResponse>;
    /**
     * 키를 삭제한다
     *
     * Available options include:
     *  recursive (bool, delete recursively)
     */
    delKey(key: string, options?: {
        recursive?: boolean;
    }): Promise<IResponse>;
    /**
     * 디렉토리를 생성한다. setKey와 유사하지만 value 를 지정하지 않는다
     */
    mkdir(dir: string, options?: any): Promise<IResponse>;
    /**
     * 디렉토리를 삭제한다. delKey와 유사함
     */
    rmdir(dir: string, options?: {
        recursive?: boolean;
    }): Promise<IResponse>;
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
    getWatcher(key: any, options?: {
        recursive?: boolean;
    }): events.EventEmitter;
    /**
     * node 를 파싱한다
     */
    static parseNode(node: INode): {};
    getIsland(name: string): Promise<{
        [host: string]: string;
    }>;
    getIslands(): Promise<Islands>;
    watchIslands(handler: (islands: Islands) => void): events.EventEmitter;
    registerIsland(name: string, value: {
        hostname: string;
        port: any;
        pattern?: string;
        protocol?: string;
    }, options?: {
        ttl?: number;
        interval?: number;
    }): Promise<(Promise<IResponse> | {
        ttl: number;
    })[]>;
    unregisterIsland(name: string): Promise<IResponse[]>;
    registerEndpoint(name: string, value: any, options?: {
        ttl?: number;
    }): Promise<IResponse>;
    getEndpoints<T>(): Promise<any>;
    deleteEndpoints(): Promise<IResponse>;
    watchEndpoints<T>(handler: (action: string, name: string, value: T) => void): events.EventEmitter;
}
