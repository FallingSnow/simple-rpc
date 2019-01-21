import {promisify} from "util";

import WebSocket from "ws";

const CALL_TIMEOUT = 10000; // 10 seconds

export default class Server extends WebSocket.Server {
    constructor(options, cb) {
        super(options, cb);

        this._registeredFunctions = {};
        this._subscriptions = {};
        this._waiting = {};

        super.on("connection", (socket, _req) => {
            if (socket.protocol === "simple-rpc") this.initSocket(socket);
        });
    }
    register(namespace, func) {
        this._registeredFunctions[namespace] = func;
        // console.debug(`Registered function ${namespace}!`);
    }
    unregister(namespace) {
        delete this._registeredFunctions[namespace];
    }
    publish() {}

    async sendSocket({type = "c", socket, namespace, response = true, ...rest}) {
        const id = socket.messageId();

        // console.debug("SocketRPC: Sending message:", {type, namespace, id, ...rest});
        await socket.send(JSON.stringify({type, namespace, id, ...rest}));

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

    // Initialize a connected socket
    // This does things like starts processing incomming messages
    initSocket(socket) {
        socket.sendSync = socket.send.bind(socket);
        socket.send = promisify(socket.sendSync.bind(socket));
        socket._messageId = 0;
        socket.messageId = () => socket._messageId++;

        // Parse incomming messages
        socket.on("message", this.handleMessage.bind(this, socket));

        // Calls that would like an associated response returned
        socket.call = async (namespace, ...data) => {
            return await this.sendSocket({socket, namespace, data});
        };

        // Calls with no response
        socket.signal = async (namespace, ...data) => {
            return await this.sendSocket({
                socket,
                namespace,
                data,
                response: false
            });
        };
    }
    async handleMessage(socket, message) {
        // console.debug("Got new message:", message);
        try {
            const msg = JSON.parse(message);

            try {
                const data = await this.processMessage(socket, msg);
                if (data)
                    await this.sendSocket({
                        type: "r",
                        id: msg.id,
                        socket,
                        data,
                        response: false
                    });
            } catch (error) {
                // eslint-disable-next-line no-console
                await this.onError(error);
                await this.sendSocket({
                    type: "r",
                    id: msg.id,
                    socket,
                    error,
                    response: false
                });
            }
        } catch (e) {
            // eslint-disable-next-line no-console
            console.warn(e);
        }
    }
    async processMessage(socket, message) {
        const {type, id, namespace, error, data} = message;

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

                const result = await func.apply(
                    socket,
                    data
                );
                // console.debug("Call results:", result);

                return result;
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
    async onError(error) {
        console.debug("SimpleRPC: Error processing message:", error);
    }
}
