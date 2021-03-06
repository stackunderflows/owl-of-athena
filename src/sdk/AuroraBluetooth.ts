//#region Import modules
import { EventEmitter } from "events";
import { Dictionary, keyBy } from "lodash";
import noble, { Characteristic, Peripheral } from "noble";

import { AuroraBluetoothParser } from "./AuroraBluetoothParser";
import {
    BLE_CMD_MAX_PACKET_LENGTH,
    BleAuroraChars,
    BleAuroraService,
    BleCmdStates,
    ConnectionStates,
    DeviceEventList,
} from "./AuroraConstants";
import { AuroraEvent, BluetoothStream, CommandResult } from "./AuroraTypes";
import { promisify, sleep } from "./util";
//#endregion

const INIT_DELAY_MS = 5000;
const DISCONNECT_RETRY_DELAY_MS = 3000;

enum PoweredStates {
    ON = "poweredOn",
    OFF = "poweredOff",
}

/**
 * Manage Bluetooth connections with Aurora devices.
 *
 * @export
 * @class AuroraBluetooth
 * @extends {EventEmitter}
 */
export class AuroraBluetooth extends EventEmitter {
    private initializing: boolean;
    private connectionState: ConnectionStates;
    private disconnectPending: boolean;
    private bluetoothParser: AuroraBluetoothParser;
    private peripheral?: noble.Peripheral;
    private characteristicsByUUID?: Dictionary<Characteristic>;
    private cmdStatusChar?: Characteristic;
    private cmdDataChar?: Characteristic;
    private cmdOutputChar?: Characteristic;
    private connectPromise?: any;

    private connectTimer?: any;

    constructor() {
        super();

        this.initializing = false;
        this.connectionState = ConnectionStates.INIT;
        this.disconnectPending = false;
        this.bluetoothParser = new AuroraBluetoothParser();
        this.bluetoothParser.on("parseError", this.onParseError);
        this.bluetoothParser.on("cmdResponseRead", this.onParseCmdResponseRead);
        this.bluetoothParser.on(
            "cmdResponseWrite",
            this.onParseCmdResponseWrite
        );
        this.bluetoothParser.on(
            "cmdInputRequested",
            this.onParseCmdInputRequested
        );
        this.bluetoothParser.on("cmdOutputReady", this.onParseCmdOutputReady);
        this.bluetoothParser.on("auroraEvent", this.onParseAuroraEvent);
        this.bluetoothParser.on("streamData", this.onParseStreamData);

        this.watchBluetoothAdapter();
    }

    public isConnected(): boolean {
        return (
            this.connectionState == ConnectionStates.IDLE ||
            this.connectionState == ConnectionStates.BUSY
        );
    }

    public isConnecting(): boolean {
        return this.connectionState == ConnectionStates.CONNECTING;
    }

    public async connect(timeoutMs = 30000): Promise<noble.Peripheral | void> {
        //if we are waiting for initialization, we'll ignore
        //any further connection attempts silently
        if (this.initializing) return;

        //has the system booted up yet? If not, we'll
        //wait for a bit and try again
        if (this.connectionState == ConnectionStates.INIT) {
            console.log("Initialized Called.");
            this.initializing = true;

            //sleep for a little bit
            await sleep(INIT_DELAY_MS);

            this.initializing = false;

            //if the state hasn't changed since we waited for
            //initialization to complete, something is wrong
            if (this.connectionState == ConnectionStates.INIT) {
                return Promise.reject(
                    "No bluetooth adapter found. Is bluetooth disabled?"
                );
            }

            //try connecting now that the system is initialized
            return this.connect(timeoutMs);
        }

        if (this.connectionState != ConnectionStates.DISCONNECTED) {
            switch (this.connectionState) {
                case ConnectionStates.CONNECTING:
                    return Promise.reject("Already connecting...");

                case ConnectionStates.BUSY:
                case ConnectionStates.IDLE:
                    return Promise.reject("Already connected.");

                default:
                    return Promise.reject(
                        "Unknown Bluetooth connection state."
                    );
            }
        }

        this.setConnectionState(ConnectionStates.CONNECTING);

        try {
            console.log("connectDevice start");
            const result = await this.connectDevice(timeoutMs);

            console.log("connectDevice succeed");
            this.peripheral = result.peripheral;
            this.peripheral!.once("disconnect", this.onPeripheralDisconnect);

            await this.setupConnection(result.characteristics);

            return this.peripheral;
        } catch (error) {
            console.error(`Occured connection error ${error}`);
            this.setConnectionState(ConnectionStates.DISCONNECTED);

            return Promise.reject(error);
        }
    }

    private async setupConnection(
        characteristics: Characteristic[]
    ): Promise<void> {
        this.characteristicsByUUID = keyBy(characteristics, "uuid");
        //these get used a lot, so let's store references
        this.cmdStatusChar = this.characteristicsByUUID[
            BleAuroraChars.CMD_STATUS
        ];
        this.cmdDataChar = this.characteristicsByUUID[BleAuroraChars.CMD_DATA];
        this.cmdOutputChar = this.characteristicsByUUID[
            BleAuroraChars.CMD_OUTPUT_INDICATED
        ];
        await this.charSubscribe(
            this.characteristicsByUUID[BleAuroraChars.STREAM_DATA_NOTIFIED],
            this.onParseStreamData
        );
        await this.charSubscribe(
            this.characteristicsByUUID[BleAuroraChars.AURORA_EVENT_NOTIFIED],
            (event: Buffer): void => {
                this.bluetoothParser.onAuroraEventCharNotification(event);
            }
        );
        await this.charSubscribe(this.cmdStatusChar, (status: Buffer): void => {
            this.bluetoothParser.onCmdStatusCharNotification(status);
        });
        await this.charSubscribe(
            this.cmdOutputChar,
            (output: unknown): void => {
                this.bluetoothParser.onCmdOutputCharNotification(output);
            }
        );

        this.setConnectionState(ConnectionStates.IDLE);
    }

    public async disconnect(): Promise<void> {
        if (
            this.connectionState == ConnectionStates.DISCONNECTED ||
            this.disconnectPending
        ) {
            return;
        }

        this.disconnectPending = true;

        //check if we are in the process of connecting, or are processing a command
        if (this.connectionState == ConnectionStates.CONNECTING) {
            noble.stopScanning();

            //give scanning a little time to stop
            await sleep(20);

            // @ts-ignore
            if (this.connectionState !== ConnectionStates.DISCONNECTED) {
                return Promise.reject(
                    "Failed to disconnect. Scanning not stopped."
                );
            }
        } else if (this.connectionState == ConnectionStates.BUSY) {
            //let's give the system a little time before we pull the plug
            await sleep(DISCONNECT_RETRY_DELAY_MS);
        }

        //have we disconnected yet?
        // @ts-ignore
        if (this.connectionState === ConnectionStates.DISCONNECTED) return;

        //nope but we can't wait any longer
        return promisify(this.peripheral!.disconnect, this.peripheral!)().then(
            () => {
                //in case disconnected event hasn't fired yet, we fire it here
                console.debug("failed connection.");
                this.setConnectionState(ConnectionStates.DISCONNECTED);
            }
        );
    }

    public async writeCmd(cmd: string): Promise<any> {
        //check for error condition
        if (this.connectionState != ConnectionStates.IDLE) {
            switch (this.connectionState) {
                case ConnectionStates.DISCONNECTED:
                    //case ConnectionStates.ADAPTER_FOUND:
                    //case ConnectionStates.DEVICE_FOUND:
                    return Promise.reject("No idle serial connection.");

                case ConnectionStates.BUSY:
                    return Promise.reject(
                        "Another command is already in progress."
                    );

                default:
                    return Promise.reject(
                        "Unknown Bluetooth connection state."
                    );
            }
        }

        if (this.disconnectPending) {
            return Promise.reject("Bluetooth currently disconnecting.");
        }

        this.setConnectionState(ConnectionStates.BUSY);

        // eslint-disable-next-line no-async-promise-executor
        return new Promise(async (resolve, reject) => {
            try {
                this.bluetoothParser.once(
                    "cmdResponse",
                    (cmdResponse: CommandResult<unknown>) => {
                        this.setConnectionState(ConnectionStates.IDLE);

                        cmdResponse.origin = "bluetooth";

                        resolve(cmdResponse);
                    }
                );

                //write the status byte, indicating start of command
                await this.charWrite(
                    this.cmdStatusChar!,
                    Buffer.from([BleCmdStates.IDLE])
                );

                await sleep(10);

                //write the actual command string as ascii (max 128bytes)
                await this.charWrite(
                    this.cmdDataChar!,
                    Buffer.from(cmd, "ascii")
                );

                await sleep(10);

                //let the parser know the command too
                this.bluetoothParser.setCmd(cmd);

                //write the status byte, indicating end of command
                await this.charWrite(
                    this.cmdStatusChar!,
                    Buffer.from([BleCmdStates.CMD_EXECUTE])
                );
                await sleep(10);
            } catch (error) {
                this.bluetoothParser.reset();
                this.bluetoothParser.removeAllListeners("cmdResponse");

                this.setConnectionState(ConnectionStates.IDLE);

                reject(error);
            }
        });
    }

    public async writeCmdInput(data: Buffer): Promise<any> {
        //check for error condition
        if (this.connectionState != ConnectionStates.BUSY) {
            switch (this.connectionState) {
                case ConnectionStates.DISCONNECTED:
                    //case ConnectionStates.ADAPTER_FOUND:
                    //case ConnectionStates.DEVICE_FOUND:
                    return Promise.reject("No idle serial connection.");

                case ConnectionStates.IDLE:
                    return Promise.reject(
                        "Command input can only be written during a command."
                    );

                default:
                    return Promise.reject(
                        "Unknown Bluetooth connection state."
                    );
            }
        }

        return this.charWrite(this.cmdDataChar!, data);
    }

    private setConnectionState(connectionState: ConnectionStates): void {
        if (this.connectionState == connectionState) {
            return;
        }

        const previousConnectionState = this.connectionState;

        this.connectionState = connectionState;

        if (this.connectionState == ConnectionStates.DISCONNECTED) {
            this.disconnectPending = false;
        }

        this.emit(
            DeviceEventList.connectionStateChange,
            connectionState,
            previousConnectionState
        );
    }

    private async connectDevice(
        timeoutMs: number
    ): Promise<{ peripheral: Peripheral; characteristics: Characteristic[] }> {
        if (this.connectPromise) {
            throw new Error("Already have a pending connection.");
        }

        return new Promise((resolve, reject) => {
            this.connectPromise = { resolve, reject };

            //remove any existing listeners just in case
            noble.removeListener("discover", this.onPeripheralFound);
            noble.removeListener("scanStop", this.onPeripheralScanStop);

            noble.on("discover", this.onPeripheralFound);
            noble.on("error", this.onPeripheralError);
            //noble.on("scanStop", this.onPeripheralScanStop);
            console.debug("bluetooth scanning start.");

            noble.startScanning([BleAuroraService], false, (error?: Error) => {
                if (error) {
                    console.debug(error);
                    reject(error.message);
                }
            });

            clearTimeout(this.connectTimer!);

            if (timeoutMs > 0) {
                console.log(`wating scanning:${timeoutMs}ms`);
                this.connectTimer = setTimeout(() => {
                    this.connectPromise = undefined;

                    noble.stopScanning();
                    noble.removeListener("discover", this.onPeripheralFound);
                    this.setConnectionState(ConnectionStates.DISCONNECTED);

                    reject("Timeout waiting for bluetooth connection.");
                }, timeoutMs);
            }
        });
    }

    private async charWritePacket(
        char: noble.Characteristic,
        packet: Buffer
    ): Promise<unknown> {
        if (!Buffer.isBuffer(packet))
            return Promise.reject("Packet parameter is not a valid buffer.");

        if (!packet.length) return Promise.resolve();

        if (packet.length > BLE_CMD_MAX_PACKET_LENGTH)
            return Promise.reject("Exceeded max write packet length.");

        return new Promise((resolve, reject) => {
            //write a packet, the false here means the callback
            //isn't executed until the other side confirms receipt
            char.write(packet, false, (error: string) => {
                if (error) return reject(error);

                resolve();
            });
        });
    }

    private async charReadPacket(
        char: noble.Characteristic
    ): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            //write a packet, the false here means the callback
            //isn't executed until the other side confirms receipt
            char.read((error: string, packet: Buffer) => {
                if (error) return reject(error);

                resolve(packet);
            });
        });
    }

    private async charWrite(
        char: noble.Characteristic,
        buffer: Buffer
    ): Promise<void> {
        if (!Buffer.isBuffer(buffer))
            throw "Buffer parameter is not a valid buffer.";

        if (!buffer.length) return;

        //process at most 20 bytes at a time
        for (
            let i = 0;
            i < buffer.length + BLE_CMD_MAX_PACKET_LENGTH;
            i += BLE_CMD_MAX_PACKET_LENGTH
        ) {
            //create a buffer slice <= 20 bytes
            //slice handles case where buffer < 20
            const packet = buffer.slice(i, i + BLE_CMD_MAX_PACKET_LENGTH);

            //if this slice is empty, nothing to do
            if (!packet.length) break;

            //remember, this happens synchronously
            await this.charWritePacket(char, packet);
        }
    }

    public async charRead(
        char: noble.Characteristic,
        numBytes: number
    ): Promise<Buffer> {
        if (numBytes <= 0) throw "Trying to read less than 1 byte.";

        const packets: Uint8Array[] = [];

        let packetCount = Math.ceil(numBytes / BLE_CMD_MAX_PACKET_LENGTH);

        //read packets until we've read all required bytes
        while (packetCount--) {
            // wait 10ms for prevent gatt error.
            //read the packet, and add it to packet array
            const packet = await this.charReadPacket(char);
            await sleep(10);
            packets.push(packet);
        }

        //waits till the last promise is resolved
        //then return the concatenated buffer
        return Buffer.concat(packets, numBytes);
    }

    private async charSubscribe(
        char: noble.Characteristic,
        onNotification: Function
    ): Promise<unknown> {
        return new Promise((resolve, reject) => {
            char.subscribe((error: string) => {
                if (error) return reject(error);

                char.on("data", onNotification);

                resolve();
            });
        });
    }

    private watchBluetoothAdapter(): void {
        this.unwatchBluetoothAdapter();

        noble.on("stateChange", this.onAdapterStateChange);
    }

    private unwatchBluetoothAdapter(): void {
        noble.removeListener("stateChange", this.onAdapterStateChange);
    }

    private onAdapterStateChange = (state: PoweredStates): void => {
        if (state == PoweredStates.ON) {
            if (this.connectionState == ConnectionStates.INIT) {
                //don't fire event here, just set connection state directly
                this.connectionState = ConnectionStates.DISCONNECTED;
            }
        } else if (state == PoweredStates.OFF) {
            this.connectionState = ConnectionStates.INIT;
        }
    };

    private onPeripheralDisconnect = (): void => {
        console.debug("onPeripheralDisconnect called.");

        if (this.disconnectPending || !this.reconnect(this.peripheral!)) {
            console.debug("Called peripheral disconnect.");
            this.setConnectionState(ConnectionStates.DISCONNECTED);
        }
    };

    private reconnect(peripheral: Peripheral): boolean {
        let reconnectResult = false;
        this.exponentialBackoff(
            3 /* max retries */,
            2 /* seconds delay */,
            async () => {
                console.log("Called toTry.");
                this.time("Connecting to Bluetooth Device... ");
                console.debug(peripheral);
                peripheral.connect((error: string) => {
                    console.debug("Start peripheral connect.");
                    if (error) {
                        console.error(error);
                        return false;
                    }
                    peripheral.discoverSomeServicesAndCharacteristics(
                        [BleAuroraService],
                        Object.values(BleAuroraChars),
                        (error, _services, characteristics) => {
                            if (error) {
                                console.error(error);
                                return;
                            }

                            console.debug("Start connection setup.");
                            this.setupConnection(characteristics);
                        }
                    );
                    reconnectResult = true;
                    return true;
                });
            },
            () => {
                console.log("> Bluetooth Device recconnected.");
            },
            () => {
                this.time("Failed to reconnect.");
            }
        );

        return reconnectResult;
    }

    // retried "max" number of times. First retry has a delay of "delay" seconds.
    // "success" is called upon success.
    private exponentialBackoff(
        max: number,
        delay: number,
        toTry: any,
        success: () => void,
        fail: () => void
    ): void {
        toTry()
            .then(() => success())
            .catch(() => {
                if (max === 0) {
                    return fail();
                }
                this.time(
                    "Retrying in " + delay + "s... (" + max + " tries left)"
                );
                setTimeout(() => {
                    this.exponentialBackoff(
                        --max,
                        delay * 2,
                        toTry,
                        success,
                        fail
                    );
                }, delay * 1000);
            });
    }

    private time(text: string): void {
        console.log("[" + new Date().toJSON().substr(11, 8) + "] " + text);
    }

    private onPeripheralFound = (peripheral: noble.Peripheral): void => {
        console.debug("onPeripheralFound called.");
        peripheral.connect((error) => {
            if (error) {
                return;
            }

            peripheral.discoverSomeServicesAndCharacteristics(
                [BleAuroraService],
                Object.values(BleAuroraChars),
                (error, _services, characteristics) => {
                    if (error) {
                        return;
                    }

                    if (!this.connectPromise) {
                        throw new Error(
                            "Peripheral found event fired without valid connection promise."
                        );
                    }

                    this.connectPromise.resolve({
                        peripheral,
                        characteristics,
                    });
                    this.connectPromise = undefined;

                    noble.stopScanning();
                }
            );
        });
    };

    private onPeripheralScanStop = (args: any): void => {
        if (args?.err) {
            console.error(args.err);
            this.peripheralStopProcess();
        }
    };

    private onPeripheralError = (error: string): void => {
        console.error(error);
        this.peripheralStopProcess();
    };

    private onParseCmdResponseRead = (
        bytesToRead: number,
        cbAfterRead: (value: Buffer) => void
    ): void => {
        this.charRead(this.cmdDataChar!, bytesToRead).then(cbAfterRead);
    };

    private onParseCmdResponseWrite = (
        buffer: Buffer,
        cbAfterWrite: (value: void) => Buffer
    ): void => {
        this.charWrite(this.cmdDataChar!, buffer).then(() => {
            this.charWrite(
                this.cmdStatusChar!,
                Buffer.from([BleCmdStates.IDLE])
            ).then(cbAfterWrite);
        });
    };

    private onParseCmdInputRequested = (): void => {
        this.emit(DeviceEventList.cmdInputRequested);
    };

    private onParseCmdOutputReady = (output: unknown): void => {
        this.emit(DeviceEventList.cmdOutputReady, output);
    };

    private onParseAuroraEvent = (auroraEvent: AuroraEvent): void => {
        auroraEvent.origin = "bluetooth";

        this.emit(DeviceEventList.auroraEvent, auroraEvent);
    };

    private onParseStreamData = (streamData: BluetoothStream): void => {
        streamData.origin = "bluetooth";

        this.emit(DeviceEventList.streamData, streamData);
    };

    private onParseError = (error: string): void => {
        this.emit(DeviceEventList.Error, "Parse Error: " + error);
    };

    private peripheralStopProcess(): void {
        clearTimeout(this.connectTimer!);
        noble.removeListener("discover", this.onPeripheralFound);
        if (this.connectPromise) {
            this.setConnectionState(ConnectionStates.DISCONNECTED);
            this.connectPromise.reject("Connection Canceled.");
            this.connectPromise = undefined;
        }
    }
}
