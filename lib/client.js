import ReconnectingWebSocket from "reconnecting-websocket";

var promisify;
if (typeof window === "undefined") {
    global.WebSocket = require("ws");
    promisify = require("util").promisify;
} else {
    promisify = require("es6-promisify").promisify;
}

const CALL_TIMEOUT = 10000; // 10 seconds
export default class Client extends ReconnectingWebSocket {
    constructor() {
        super(arguments[0], "simple-rpc");
        this.send = promisify(super.send);
        this._registeredFunctions = {};
        this._waiting = {};
        this._messageId = 0;
        this.addEventListener("message", this.handleMessage.bind(this));
    }
    messageId() {
        return this._messageId++;
    }
    // Calls that would like an associated response returned
    async call(namespace, ...data) {
        return await this.sendMessage({namespace, data});
    }
    // Calls with no response
    async signal(namespace, ...data) {
        return await this.sendMessage({namespace, data, response: false});
    }
    register(namespace, func) {
        this._registeredFunctions[namespace] = func;
    }
    unregister(namespace) {
        delete this._registeredFunctions[namespace];
    }
    async sendMessage({
        id = this.messageId(),
        type = "c",
        namespace,
        data,
        response = true
    }) {
        await super.send(JSON.stringify({type, namespace, id, data}));

        if (response) {
            const promise = new Promise((res, rej) => {
                this._waiting[id] = {
                    res,
                    rej
                };
            });

            this._waiting[id].timeout = setTimeout(() => {
                const rejectionHandler = this._waiting[id]
                    ? this._waiting[id].rej
                    : undefined;
                if (rejectionHandler) {
                    rejectionHandler(
                        new Error(`Call to "${namespace}" timed out.`)
                    );
                    delete this._waiting[id];
                }
            }, CALL_TIMEOUT);

            return await promise;
        }
    }
    on() {
        this.addEventListener(...arguments);
    }
    off() {
        this.removeEventListener(...arguments);
    }
    async handleMessage(message) {
        try {
            message = JSON.parse(message.data);
        } catch (e) {
            // eslint-disable-next-line no-console
            console.error(e);
        }
        const {type, id, namespace, error, data} = message;
        // console.debug("Got message:", message);

        switch (type) {
            // Call
            case "c": {
                const func =
                    this._registeredFunctions[namespace] ||
                    this._registeredFunctions["*"];

                // Check if called namespace exists
                if (!func)
                    throw new Error(
                        `Call to unregistered namespace "${namespace}".`
                    );

                const result = await this._registeredFunctions[namespace].apply(
                    this,
                    data
                );

                return this.sendMessage({
                    id,
                    type: "r",
                    data: result,
                    response: false
                });
            }
            // Response
            case "r": {
                const response = this._waiting[id];

                if (!response) return;

                const {res, rej, timeout} = response;
                clearTimeout(timeout);
                delete this._waiting[id];

                if (error) {
                    return rej(error);
                }

                return res(data);
            }
        }
    }
}
