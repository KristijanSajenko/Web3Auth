import Common, { Hardfork } from "@ethereumjs/common";
import { TransactionFactory } from "@ethereumjs/tx";
import {
  decrypt,
  EthEncryptedData,
  getEncryptionPublicKey,
  MessageTypes,
  personalSign,
  signTypedData,
  SignTypedDataVersion,
  TypedDataV1,
  TypedMessage,
} from "@metamask/eth-sig-util";
import { createSwappableProxy, providerFromEngine, signMessage } from "@toruslabs/base-controllers";
import { JRPCEngine, JRPCMiddleware, JRPCRequest } from "@toruslabs/openlogin-jrpc";
import { CHAIN_NAMESPACES, CustomChainConfig, RequestArguments, SafeEventEmitterProvider } from "@web3auth/base";
import { BaseProvider, BaseProviderConfig, BaseProviderState, createRandomId } from "@web3auth/base-provider";
import { ethErrors } from "eth-rpc-errors";
import { privateToAddress, stripHexPrefix } from "ethereumjs-util";
import log from "loglevel";

import {
  AddEthereumChainParameter,
  createAccountMiddleware,
  createChainSwitchMiddleware,
  createEthMiddleware,
  IAccountHandlers,
  IChainSwitchHandlers,
  IProviderHandlers,
} from "../../rpc/ethRpcMiddlewares";
import { createJsonRpcClient } from "../../rpc/jrpcClient";
import { MessageParams, TransactionParams, TypedMessageParams } from "../../rpc/walletMidddleware";

export interface EthereumPrivKeyProviderConfig extends BaseProviderConfig {
  chainConfig: Omit<CustomChainConfig, "chainNamespace">;
}

export interface EthereumPrivKeyProviderState extends BaseProviderState {
  privateKey?: string;
}
export class EthereumPrivateKeyProvider extends BaseProvider<BaseProviderConfig, EthereumPrivKeyProviderState, string> {
  constructor({ config, state }: { config: EthereumPrivKeyProviderConfig; state?: EthereumPrivKeyProviderState }) {
    super({ config: { chainConfig: { ...config.chainConfig, chainNamespace: CHAIN_NAMESPACES.EIP155 } }, state });
  }

  public static getProviderInstance = async (params: {
    privKey: string;
    chainConfig: Omit<CustomChainConfig, "chainNamespace">;
  }): Promise<SafeEventEmitterProvider> => {
    const providerFactory = new EthereumPrivateKeyProvider({ config: { chainConfig: params.chainConfig } });
    await providerFactory.setupProvider(params.privKey);
    return providerFactory;
  };

  public async enable(): Promise<string[]> {
    if (!this.state.privateKey)
      throw ethErrors.provider.custom({ message: "Private key is not found in state, plz pass it in constructor state param", code: -32603 });
    await this.setupProvider(this.state.privateKey);
    return this._providerEngineProxy.sendAsync({ jsonrpc: "2.0", id: createRandomId(), method: "eth_accounts" });
  }

  public async setupProvider(privKey: string): Promise<void> {
    const providerHandlers: IProviderHandlers = {
      getAccounts: async (_: JRPCRequest<unknown>) => [`0x${privateToAddress(Buffer.from(privKey, "hex")).toString("hex")}`],
      getPrivateKey: async (_: JRPCRequest<unknown>) => privKey,
      processTransaction: async (txParams: TransactionParams, _: JRPCRequest<unknown>): Promise<string> => {
        if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: -32603 });
        const common = await this.getCommonConfiguration(!!txParams.maxFeePerGas && !!txParams.maxPriorityFeePerGas);
        const unsignedEthTx = TransactionFactory.fromTxData(txParams, { common });
        const signedTx = unsignedEthTx.sign(Buffer.from(privKey, "hex")).serialize();
        const txHash = await this._providerEngineProxy.sendAsync<string[], string>({
          method: "eth_sendRawTransaction",
          params: [`0x${signedTx.toString("hex")}`],
          id: createRandomId(),
          jsonrpc: "2.0",
        });
        return txHash;
      },
      processSignTransaction: async (txParams: TransactionParams, _: JRPCRequest<unknown>): Promise<string> => {
        const common = await this.getCommonConfiguration(!!txParams.maxFeePerGas && !!txParams.maxPriorityFeePerGas);
        const unsignedEthTx = TransactionFactory.fromTxData(txParams, { common });
        const signedTx = unsignedEthTx.sign(Buffer.from(privKey, "hex")).serialize();
        return `0x${signedTx.toString("hex")}`;
      },
      processEthSignMessage: async (msgParams: MessageParams<string>, _: JRPCRequest<unknown>): Promise<string> => {
        const rawMessageSig = signMessage(privKey, msgParams.data);
        return rawMessageSig;
      },
      processPersonalMessage: async (msgParams: MessageParams<string>, _: JRPCRequest<unknown>): Promise<string> => {
        const privKeyBuffer = Buffer.from(privKey, "hex");
        const sig = personalSign({ privateKey: privKeyBuffer, data: msgParams.data });
        return sig;
      },
      processTypedMessage: async (msgParams: MessageParams<TypedDataV1>, _: JRPCRequest<unknown>): Promise<string> => {
        log.debug("processTypedMessage", msgParams);
        const privKeyBuffer = Buffer.from(privKey, "hex");
        const sig = signTypedData({ privateKey: privKeyBuffer, data: msgParams.data, version: SignTypedDataVersion.V1 });
        return sig;
      },
      processTypedMessageV3: async (msgParams: TypedMessageParams<TypedMessage<MessageTypes>>, _: JRPCRequest<unknown>): Promise<string> => {
        log.debug("processTypedMessageV3", msgParams);
        const privKeyBuffer = Buffer.from(privKey, "hex");
        const sig = signTypedData({ privateKey: privKeyBuffer, data: msgParams.data, version: SignTypedDataVersion.V3 });
        return sig;
      },
      processTypedMessageV4: async (msgParams: TypedMessageParams<TypedMessage<MessageTypes>>, _: JRPCRequest<unknown>): Promise<string> => {
        log.debug("processTypedMessageV4", msgParams);
        const privKeyBuffer = Buffer.from(privKey, "hex");
        const sig = signTypedData({ privateKey: privKeyBuffer, data: msgParams.data, version: SignTypedDataVersion.V4 });
        return sig;
      },
      processEncryptionPublicKey: async (address: string, _: JRPCRequest<unknown>): Promise<string> => {
        log.info("processEncryptionPublicKey", address);
        return getEncryptionPublicKey(privKey);
      },
      processDecryptMessage: (msgParams: MessageParams<string>, _: JRPCRequest<unknown>): string => {
        log.info("processDecryptMessage", msgParams);
        const stripped = stripHexPrefix(msgParams.data);
        const buff = Buffer.from(stripped, "hex");
        const decrypted = decrypt({ encryptedData: JSON.parse(buff.toString("utf8")) as EthEncryptedData, privateKey: privKey });
        return decrypted;
      },
    };

    const ethMiddleware = createEthMiddleware(providerHandlers);
    const chainSwitchMiddleware = this.getChainSwitchMiddleware();
    const engine = new JRPCEngine();
    // Not a partial anymore because of checks in ctor
    const { networkMiddleware } = createJsonRpcClient(this.config.chainConfig as CustomChainConfig);
    engine.push(ethMiddleware);
    engine.push(chainSwitchMiddleware);
    engine.push(this.getAccountMiddleware());
    engine.push(networkMiddleware);
    const provider = providerFromEngine(engine);
    const providerWithRequest = {
      ...provider,
      request: async (args: RequestArguments) => {
        return provider.sendAsync({ jsonrpc: "2.0", id: createRandomId(), ...args });
      },
    } as SafeEventEmitterProvider;
    this._providerEngineProxy = createSwappableProxy<SafeEventEmitterProvider>(providerWithRequest);
    await this.lookupNetwork();
  }

  public async updateAccount(params: { privateKey: string }): Promise<void> {
    if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: -32603 });
    const existingKey = await this._providerEngineProxy.sendAsync<[], string>({ jsonrpc: "2.0", id: createRandomId(), method: "eth_private_key" });
    if (existingKey !== params.privateKey) {
      await this.setupProvider(params.privateKey);
      this._providerEngineProxy.emit("accountsChanged", {
        accounts: await this._providerEngineProxy.sendAsync<[], string[]>({ jsonrpc: "2.0", id: createRandomId(), method: "eth_accounts" }),
      });
    }
  }

  public async switchChain(params: { chainId: string }): Promise<void> {
    if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: -32603 });
    const chainConfig = this.getChainConfig(params.chainId);
    this.update({
      chainId: "loading",
    });
    this.configure({ chainConfig });
    const privKey = await this._providerEngineProxy.sendAsync<[], string>({ jsonrpc: "2.0", id: createRandomId(), method: "eth_private_key" });
    await this.setupProvider(privKey);
  }

  protected async lookupNetwork(): Promise<string> {
    if (!this._providerEngineProxy) throw ethErrors.provider.custom({ message: "Provider is not initialized", code: -32603 });
    const { chainId } = this.config.chainConfig;
    if (!chainId) throw ethErrors.rpc.invalidParams("chainId is required while lookupNetwork");
    const network = await this._providerEngineProxy.sendAsync<[], string>({
      jsonrpc: "2.0",
      id: createRandomId(),
      method: "net_version",
      params: [],
    });

    if (parseInt(chainId, 16) !== parseInt(network, 10)) throw ethErrors.provider.chainDisconnected(`Invalid network, net_version is: ${network}`);

    if (this.state.chainId !== chainId) {
      this.emit("chainChanged", this.state.chainId);
      this.emit("connect", { chainId });
    }
    this.update({ chainId });
    return network;
  }

  private async getCommonConfiguration(supportsEIP1559: boolean) {
    const { displayName: name } = this.config.chainConfig;
    const hardfork = supportsEIP1559 ? Hardfork.London : Hardfork.Berlin;
    const { chainId } = this.state;

    const customChainParams = {
      name,
      chainId: chainId === "loading" ? 0 : parseInt(chainId, 16),
      networkId: chainId === "loading" ? 0 : Number.parseInt(chainId, 10),
      hardfork,
    };

    return Common.custom(customChainParams);
  }

  private getChainSwitchMiddleware(): JRPCMiddleware<unknown, unknown> {
    const chainSwitchHandlers: IChainSwitchHandlers = {
      addChain: async (params: AddEthereumChainParameter): Promise<void> => {
        const { chainId, chainName, rpcUrls, blockExplorerUrls, nativeCurrency } = params;
        this.addChain({
          chainNamespace: "eip155",
          chainId,
          ticker: nativeCurrency?.symbol || "ETH",
          tickerName: nativeCurrency?.name || "Ether",
          displayName: chainName,
          rpcTarget: rpcUrls[0],
          blockExplorer: blockExplorerUrls?.[0] || "",
        });
      },
      switchChain: async (params: { chainId: string }): Promise<void> => {
        const { chainId } = params;
        await this.switchChain({ chainId });
      },
    };
    const chainSwitchMiddleware = createChainSwitchMiddleware(chainSwitchHandlers);
    return chainSwitchMiddleware;
  }

  private getAccountMiddleware(): JRPCMiddleware<unknown, unknown> {
    const accountHandlers: IAccountHandlers = {
      updatePrivatekey: async (params: { privateKey: string }): Promise<void> => {
        const { privateKey } = params;
        await this.updateAccount({ privateKey });
      },
    };
    return createAccountMiddleware(accountHandlers);
  }
}
