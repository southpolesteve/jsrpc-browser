export default {
    async fetch(request, env, ctx) {
        console.log("Worker fetch triggered:", request.method, request.url);

        const url = new URL(request.url);

        if (url.pathname === "/rpc" && request.headers.get("Upgrade") === "websocket") {
            console.log("-> Worker: Upgrading to WebSocket on /rpc");
            const [client, server] = Object.values(new WebSocketPair());
            server.accept()

            // We'll track calls by questionId
            const questionsInFlight = new Map();

            server.addEventListener("message", async (event) => {
                console.log("-> Worker WS message:", event.data);

                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch (err) {
                    console.error("-> Worker: JSON parse error:", err);
                    server.send(JSON.stringify({
                        type: "exception",
                        answerId: 0,
                        error: "Invalid JSON",
                    }));
                    return;
                }

                if (msg.type === "call") {
                    const { questionId, method, params } = msg;
                    console.log(`-> Worker: Received call #${questionId}, method="${method}"`);

                    // 1) Mark this question as "in flight" RIGHT AWAY.
                    //    This ensures pipelined calls referencing questionId can find it.
                    if (!questionsInFlight.has(questionId)) {
                        questionsInFlight.set(questionId, {
                            done: false,
                            result: null,
                            promise: null,
                            resolve: null,
                            reject: null
                        });
                    }

                    // 2) Resolve any pipelined references in params.
                    let resolvedArgs;
                    try {
                        resolvedArgs = await Promise.all(params.map(p => maybeResolveParam(p)));
                    } catch (err) {
                        console.error("-> Worker: Error resolving param:", err.message);
                        server.send(JSON.stringify({
                            type: "exception",
                            answerId: questionId,
                            error: err.message
                        }));
                        return;
                    }

                    // 3) Run the method
                    let result, error;
                    try {
                        if (method === "makeGreeting") {
                            result = await makeGreeting(...resolvedArgs);
                        } else if (method === "appendSuffix") {
                            result = await appendSuffix(...resolvedArgs);
                        } else {
                            error = `Unknown method "${method}"`;
                        }
                    } catch (e) {
                        error = e.message || String(e);
                    }

                    // 4) Return or exception
                    if (error) {
                        console.log(`-> Worker: Sending exception for call #${questionId}:`, error);
                        server.send(JSON.stringify({
                            type: "exception",
                            answerId: questionId,
                            error
                        }));
                    } else {
                        console.log(`-> Worker: Sending return for call #${questionId}:`, result);
                        finalizeQuestion(questionId, result);
                        server.send(JSON.stringify({
                            type: "return",
                            answerId: questionId,
                            result
                        }));
                    }
                }
            });

            server.addEventListener("close", (event) => {
                console.log("-> Worker WS 'close':", event);
            });
            server.addEventListener("error", (event) => {
                console.log("-> Worker WS 'error':", event);
            });

            console.log("-> Worker: Returning 101 with webSocket: server");
            return new Response(null, { status: 101, webSocket: client });

            // =============================
            // Helper functions below
            // =============================

            function finalizeQuestion(qId, result) {
                const entry = questionsInFlight.get(qId);
                entry.done = true;
                entry.result = result;
                if (entry.resolve) {
                    entry.resolve(result);
                }
            }

            async function maybeResolveParam(param) {
                // If param is { resultOf: X }, it references another call's result
                if (
                    param &&
                    typeof param === "object" &&
                    param !== null &&
                    "resultOf" in param
                ) {
                    const refId = param.resultOf;
                    console.log(`-> Worker: Param references result of call #${refId}`);

                    if (!questionsInFlight.has(refId)) {
                        throw new Error(`Reference to unknown call #${refId}`);
                    }
                    const q = questionsInFlight.get(refId);
                    if (q.done) {
                        console.log(`-> Worker: Call #${refId} done => returning result`);
                        return q.result;
                    } else {
                        console.log(`-> Worker: Call #${refId} in flight => waiting...`);
                        // If we haven't created a promise yet, create one that resolves once finalizeQuestion() is called
                        if (!q.promise) {
                            q.promise = new Promise((resolve, reject) => {
                                q.resolve = resolve;
                                q.reject = reject;
                            });
                        }
                        return await q.promise;
                    }
                }

                // Otherwise, just return the param as is
                return param;
            }

            // Example "methods" with a small delay to show pipelining effect
            async function makeGreeting(name) {
                console.log(`-> Worker: makeGreeting("${name}")`);
                await new Promise((r) => setTimeout(r, 10));
                return `Hello, ${name}!`;
            }
            async function appendSuffix(text, suffix) {
                console.log(`-> Worker: appendSuffix("${text}", "${suffix}")`);
                await new Promise((r) => setTimeout(r, 10));
                return text + suffix;
            }
        }

        // If not /rpc, or no Upgrade: websocket
        console.log("-> Worker: Not /rpc or no Upgrade -> returning 404");
        return new Response("Not found", { status: 404 });
    },
};