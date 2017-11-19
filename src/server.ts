import { Observable } from 'rxjs/Observable';
import { Subscription } from 'rxjs/Subscription';
import { IpcMain, Event, WebContents } from 'electron';
import { 
    Request, RequestType, Response, ResponseType,
    GetRequest, ApplyRequest, SubscribeRequest, UnsubscribeRequest,
    ProxyDescriptor, ProxyPropertyType
} from './common';
const Errio = require('errio');

const registrations: { [channel: string]: ProxyServerHandler | null } = {};

export function registerProxy<T>(transport: IpcMain, target: T, descriptor: ProxyDescriptor): VoidFunction {
    const { channel } = descriptor;
    
    if (registrations[channel]) {
        throw new Error(`Proxy object has already been registered on channel ${channel}`);
    }
    
    const server = new ProxyServerHandler(target);
    registrations[channel] = server;

    transport.on(channel, (event: Event, request: Request, correlationId: string) => {
        const { sender } = event;
        server.handleRequest(request, sender)        
            .then(result => sender.send(correlationId, { type: ResponseType.Result, result }))
            .catch(error => sender.send(correlationId, { type: ResponseType.Error, error: Errio.stringify(error) }));
    });

    return () => unregisterProxy(channel, transport);
}

function unregisterProxy(channel: string, transport: IpcMain) {
    transport.removeAllListeners(channel);
    const server = registrations[channel];

    if (!server) {
        throw new Error(`No proxy is registered on channel ${channel}`);
    }

    server.unsubscribeAll();
    registrations[channel] = null;
}

class ProxyServerHandler{
    constructor(private target: any) {}

    private subscriptions: { [subscriptionId: string]: Subscription } = {};
    
    public async handleRequest(request: Request, sender: WebContents): Promise<any> {
        switch (request.type) {
            case RequestType.Get:
                return this.handleGet(request);
            case RequestType.Apply:
                return this.handleApply(request);
            case RequestType.Subscribe:
                return this.handleSubscribe(request, sender);
           case RequestType.Unsubscribe:
                return this.handleUnsubscribe(request);
            default:
                throw new Error(`Unhandled RequestType [${request.type}]`);
        }
    }

    public unsubscribeAll() {
        Object.values(this.subscriptions).forEach(subscription => subscription.unsubscribe());
        this.subscriptions = {};
    }

    private handleGet(request: GetRequest): Promise<any> {
        return this.target[request.propKey];
    }

    private handleApply(request: ApplyRequest): any {
        const { propKey, args } = request;
        const func = this.target[propKey];

        if (!isFunction(func)) {
            throw new Error(`Property [${propKey}] is not a function`)
        }

        return func(...args);
    }

    private handleSubscribe(request: SubscribeRequest, sender: WebContents) {
        const { propKey, subscriptionId } = request;

        if (this.subscriptions[subscriptionId]) {
            throw new Error(`A subscription with Id [${subscriptionId}] already exists`);
        }

        const obs = this.target[propKey];

        if (!isObservable(obs)) {
            throw new Error(`Property [${propKey}] is not an observable`);
        }

        this.subscriptions[subscriptionId] = obs.subscribe(
            (value) => sender.send(subscriptionId, { type: ResponseType.Next, value }),
            (error: Error) => sender.send(subscriptionId, { type: ResponseType.Error, error: Errio.stringify(error) }),
            () => sender.send(subscriptionId, { type: ResponseType.Complete }),
        );

        /* If the sender does not clean up after itself then we need to do it */
        sender.once('destroyed', () => this.doUnsubscribe(subscriptionId));        
    }
        
    private handleUnsubscribe(request: UnsubscribeRequest) {
        const { subscriptionId } = request;

        if (!this.subscriptions[subscriptionId]) {
            throw new Error(`Subscription with Id [${subscriptionId}] does not exist`);
        }

        this.doUnsubscribe(subscriptionId);
    }

    private doUnsubscribe(subscriptionId: string) {
        const subscription = this.subscriptions[subscriptionId];

        if (subscription) {        
            subscription.unsubscribe();
            delete this.subscriptions[subscriptionId];
        }
    }
}

function isFunction(value: any): value is Function {
    return value && typeof value === 'function';
}

function isObservable<T>(value: any): value is Observable<T> {
    return value && typeof value.subscribe === 'function'
}

function isPromise<T>(value: any): value is Promise<T> {
    return value && typeof value.subscribe !== 'function' && typeof value.then === 'function';
}

export { ProxyDescriptor, ProxyPropertyType }