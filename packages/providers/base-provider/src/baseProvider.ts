import { BaseConfig, BaseController, BaseState } from "@toruslabs/base-controllers";
import { JRPCRequest } from "@toruslabs/openlogin-jrpc";
import { CustomChainConfig, Maybe, RequestArguments, SafeEventEmitterProvider, SendCallBack, WalletInitializationError } from "@web3auth/base";
import { ethErrors } from "eth-rpc-errors";

import { IBaseProvider } from "./IBaseProvider";
import { createRandomId } from "./utils";

export interface BaseProviderState extends BaseState {
  chainId: string;
}

export interface BaseProviderConfig extends BaseConfig {
  chainConfig: Partial<CustomChainConfig>;
  networks?: Record<string, CustomChainConfig>;
}

export abstract class BaseProvider<C extends BaseProviderConfig, S extends BaseProviderState, P>
  extends BaseController<C, S>
  implements IBaseProvider<P>
{
  // should be Assigned in setupProvider
  public _providerEngineProxy: SafeEventEmitterProvider | null = null;

  constructor({ config, state }: { config?: C; state?: S }) {
    super({ config, state });
    if (!config.chainConfig) throw WalletInitializationError.invalidProviderConfigError("Please provide chainConfig");
    if (!config.chainConfig.chainId) throw WalletInitializationError.invalidProviderConfigError("Please provide chainId inside chainConfig");
    if (!config.chainConfig.rpcTarget) throw WalletInitializationError.invalidProviderConfigError("Please provide rpcTarget inside chainConfig");
    this.defaultState = {
      chainId: "loading",
    } as S;
    this.defaultConfig = {
      chainConfig: config.chainConfig,
      networks: { [config.chainConfig.chainId]: config.chainConfig },
    } as C;
    super.initialize();
  }

  get isInitialized(): boolean {
    return !!this._providerEngineProxy;
  }

  set isInitialized(_) {
    throw new Error("Method not implemented.");
  }

  public addChain(chainConfig: CustomChainConfig): void {
    if (!chainConfig.chainId) throw ethErrors.rpc.invalidParams("chainId is required");
    if (!chainConfig.rpcTarget) throw ethErrors.rpc.invalidParams("chainId is required");
    this.configure({
      networks: { ...this.config.networks, [chainConfig.chainId]: chainConfig },
    } as C);
  }

  public getChainConfig(chainId: string): CustomChainConfig | undefined {
    const chainConfig = this.config.networks?.[chainId];
    if (!chainConfig) throw ethErrors.rpc.invalidRequest(`Chain ${chainId} is not supported, please add chainConfig for it`);
    return chainConfig;
  }

  public async sendAsync<T, U>(req: JRPCRequest<T>): Promise<U> {
    if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: -32603 });
    return this._providerEngineProxy.sendAsync(req);
  }

  public async request<T>(args: RequestArguments): Promise<Maybe<T>> {
    if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: -32603 });
    return this._providerEngineProxy.sendAsync({ jsonrpc: "2.0", id: createRandomId(), ...args });
  }

  public send<T, U>(req: JRPCRequest<T>, callback: SendCallBack<U>): void {
    if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: -32603 });
    return this._providerEngineProxy.send(req, callback);
  }

  abstract setupProvider(provider: P): Promise<void>;

  protected abstract lookupNetwork(provider?: P): Promise<string | void>;
}
