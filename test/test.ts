import test from 'ava';
import { Observable, of, interval, throwError } from 'rxjs';
import { bufferTime, take, toArray } from 'rxjs/operators';
import { ProxyPropertyType } from '../src/common';
import { IpcProxyError } from '../src/utils';
import { registerProxy } from '../src/server';
import { createProxy } from '../src/client';
import { mockIpc, delay } from './_mocks';
import { IpcMain, IpcRenderer } from 'electron';

class ProxiedClass {
    stringMemberSync = 'a string';
    stringMemberAsync = Promise.resolve('a string promise');
    get stringGetter() { return this.stringMemberSync; }
    throwErrorSync() { throw new Error('an error'); }
    throwErrorAsync() { return Promise.reject(new Error('a rejection')); }
    addSync = (num1: number, num2: number) => num1 + num2;
    addAsync = (num1: number, num2: number) => Promise.resolve(num1 + num2);
    returnStringMember() { return this.stringMemberSync; }
    respondAfter = (millis: number) => new Promise(resolve => setTimeout(resolve, millis));
    observableProp = of(1, 2, 3);
    observableHot = interval(100);
    observableError = throwError(new Error('error on stream'));
    makeObservable = (...args: number[]) => of(...args);
    makeObservableHot = (millis: number) => interval(millis);
    makeObservableError = () => throwError(new Error('error on stream'));
    returnObservableProp = () => this.observableProp;
    privateProperty = 42;
}

interface ProxyObject {
    stringMemberSync: Promise<string>;
    stringMemberAsync: Promise<string>;
    stringGetter: Promise<string>;
    throwErrorSync(): Promise<any>;
    throwErrorAsync(): Promise<any>;
    addSync(num1: number, num2: number): Promise<number>;
    addAsync(num1: number, num2: number): Promise<number>;
    returnStringMember(): Promise<string>;
    respondAfter(millis: number): Promise<void>;
    observableProp: Observable<number>;
    observableError: Observable<any>;
    observableHot: Observable<any>;
    makeObservable: (...args: number[]) => Observable<number>;
    makeObservableError: () => Observable<any>;
    makeObservableHot: (interval: number) => Observable<any>;
    returnObservableProp: () => Observable<number>;
    privateProperty: Promise<number>;
    missingFunction: () => Promise<number>;
}

const descriptor = {
    channel: 'channelName',
    properties: {
        stringMemberSync: ProxyPropertyType.Value,
        stringMemberAsync: ProxyPropertyType.Value,
        stringGetter: ProxyPropertyType.Value,
        throwErrorSync: ProxyPropertyType.Function,
        throwErrorAsync: ProxyPropertyType.Function,
        addSync: ProxyPropertyType.Function,
        addAsync: ProxyPropertyType.Function,
        returnStringMember: ProxyPropertyType.Function,
        respondAfter: ProxyPropertyType.Function,
        observableProp: ProxyPropertyType.Value$,
        observableError: ProxyPropertyType.Value$,
        observableHot: ProxyPropertyType.Value$,
        makeObservable: ProxyPropertyType.Function$,
        makeObservableError: ProxyPropertyType.Function$,
        makeObservableHot: ProxyPropertyType.Function$,
        returnObservableProp: ProxyPropertyType.Function$,
        missingFunction: ProxyPropertyType.Function
    }
};

let ipcMain: IpcMain = null;
let ipcRenderer: IpcRenderer = null;
let unregister: VoidFunction = null;
let client: ProxyObject = null;

test.beforeEach(t => {
    ({ ipcMain, ipcRenderer } = mockIpc());
    unregister = registerProxy(new ProxiedClass(), descriptor, ipcMain);
    client = createProxy<ProxyObject>(descriptor, Observable, ipcRenderer);
});

test.afterEach.always(t => {
    unregister();
});

test('Value: returns string property', async t => {
    t.is(await client.stringMemberSync, 'a string');
});

test('Value: memoizes the Promise', async t => {
    t.is(client.stringMemberSync, client.stringMemberSync);
});

test('Value: binds "this" correctly when accessing getter', async t => {
    t.is(await client.stringGetter, "a string");
});

test('Value: returns string property from promise', async t => {
    t.is(await client.stringMemberAsync, 'a string promise');
});

test('Function: returns errors thrown synchronously', t => {
    return t.throws(client.throwErrorSync(), 'an error');
});

test('Function: returns rejected promise', t => {
    return t.throws(client.throwErrorAsync(), 'a rejection');
});

test('Function: handles function which returns result synchronously', async t => {
    t.is(await client.addSync(4, 5), 9);
});

test('Function: handles function which returns a promise', async t => {
    t.is(await client.addAsync(4, 7), 11);
});

test('Function: memoizes the function', async t => {
    t.is(client.addAsync, client.addAsync);
});

test('Function: binds "this" correctly when calling function', async t => {
    t.is(await client.returnStringMember(), "a string");
});

test('Function: does not respond to promises after renderer emits "destroyed" event', async t => {
    let counter = 0;
    client.respondAfter(200).then(() => counter ++).catch(() => counter ++);
    ipcRenderer.emit('destroyed');    
    await delay(250);
    t.is(counter, 0);
});

test('Value$: returns observable property', async t => {
    t.deepEqual(await client.observableProp.pipe(toArray()).toPromise(), [1, 2, 3]);
});

test('Value$: handles observable errors', async t => {
    return t.throws(client.observableError.toPromise());
});

test('Value$: handles hot observable streams', async t => {
    return t.is(await client.observableHot.pipe(bufferTime(220), take(1)).toPromise().then(arr => arr.length), 2);
});

test('Value$: unsubscribes from hot observable streams', async t => {
    let counter = 0;
    const subscription = client.observableHot.subscribe(() => counter++);
    await delay(250);
    t.is(counter, 2);
    subscription.unsubscribe()
    await delay(250);
    t.is(counter, 2);
});

test('Value$: automatically unsubscribes when renderer emits "destroyed" event', async t => {
    let counter = 0;
    client.observableHot.subscribe(() => counter++);
    await delay(250);
    t.is(counter, 2);
    ipcRenderer.emit('destroyed');
    await delay(250);
    t.is(counter, 2);
});

test('Function$: returns observable', async t => {
    t.deepEqual(await client.makeObservable(1, 2).pipe(toArray()).toPromise(), [1, 2]);
});

test('Function$: returns observable errors', async t => {
    return t.throws(client.makeObservableError().toPromise());
});

test('Function$: makes hot observable streams', async t => {
    return t.is(await client.makeObservableHot(80).pipe(bufferTime(280), take(1)).toPromise().then(arr => arr.length), 3);
});

test('Function$: unsubscribes from hot observable streams', async t => {
    let counter = 0;
    const subscription = client.makeObservableHot(50).subscribe(() => counter++);
    await delay(110);
    t.is(counter, 2);
    subscription.unsubscribe()
    await delay(110);
    t.is(counter, 2);
});

test('Function$: automatically unsubscribes when renderer emits "destroyed" event', async t => {
    let counter = 0;
    client.makeObservableHot(50).subscribe(() => counter++);
    await delay(110);
    t.is(counter, 2);
    ipcRenderer.emit('destroyed');
    await delay(110);
    t.is(counter, 2);
});

/* Error handling */

test('registerProxy: throws when channel is already registered', t => {
    return t.throws(() => registerProxy({}, { channel: 'channelName', properties: {} }));
});

test('createProxy: throws if the Observable constructor is not passed and an Observable property is accessed', t => {
    return t.throws(() => createProxy({ channel: 'anotherChannel', properties: { someObservable: ProxyPropertyType.Value$ } }, undefined, ipcRenderer));
});

test('createProxy: does not throw if the Observable constructor is not passed and there are no Observable properties', t => {
    return t.notThrows(() => createProxy({ channel: 'anotherChannel', properties: { someProp: ProxyPropertyType.Value } }, undefined, ipcRenderer));
});

test('proxy: throws when trying to set property', t => {
    return t.throws(() => client.stringMemberSync = Promise.resolve('newvalue'));
});

test('proxy: returns undefined when trying to access a property which has not been exposed', t => {
    return t.is(client.privateProperty, undefined);
});

test('proxy: throws when trying to call a function which does not exist', t => {
    return t.throws(client.missingFunction());
});

test('IpcProxyError: shows "IpcProxyError" in the output', t => {
    return t.is(new IpcProxyError('some message').toString(), 'IpcProxyError: some message');
});

test('IpcProxyError: shows "IpcProxyError" in the remote output', t => {
    return client.missingFunction()
        .then(() => t.fail('unexpected resolve'))
        .catch(err => t.is(err.toString(), 'IpcProxyError: Remote property [missingFunction] is not a function'));
});

