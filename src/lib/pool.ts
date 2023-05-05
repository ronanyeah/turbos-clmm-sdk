import {
  TransactionBlock,
  JsonRpcProvider,
  SuiAddress,
  SuiTransactionBlockResponse,
  SUI_CLOCK_OBJECT_ID,
  getObjectType,
  CoinMetadata,
} from '@mysten/sui.js';
import Decimal from 'decimal.js';
import { Contract } from './contract';
import { validateObjectResponse } from '../utils/validate-object-response';
import { Base } from './base';
import BN from 'bn.js';

const ONE_MINUTE = 60 * 1000;

export declare module Pool {
  export interface MintParams {
    amount: [a: Decimal.Value, b: Decimal.Value];
    /**
     * Acceptable wasted amount. Range: `[0, 100)`, unit: `%`
     */
    slippage: Decimal.Value;
    /**
     * Execute transaction by signer
     * ```typescript
     * import { RawSigner } from '@mysten/sui.js';
     * {
     *   signAndExecute(txb, provider) {
     *     const mnemonic = sdk.account.generateMnemonic(); // OR from your own
     *     const keypair = sdk.account.getKeypairFromMnemonics(mnemonic);
     *     const signer = new RawSigner(keypair, provider);
     *     return signer.signAndExecuteTransactionBlock(txb);
     *   },
     * }
     * ```
     * @see RawSigner
     */
    signAndExecute: (
      txb: TransactionBlock,
      provider: JsonRpcProvider,
    ) => Promise<SuiTransactionBlockResponse>;
  }

  export interface LiquidityParams {
    address: SuiAddress;
    minPrice: Decimal.Value;
    maxPrice: Decimal.Value;
  }

  export interface CreatePoolOptions extends MintParams, LiquidityParams {
    /**
     * Fee object from `sdk.contract.getFees()`
     */
    fee: Contract.Fee;
    /**
     * Coin type such as `0x2::sui::SUI`
     */
    coins: [a: string, b: string];
    currentPrice: Decimal.Value;
  }

  export interface AddLiquidityOptions extends MintParams, LiquidityParams {
    /**
     * Pool ID
     */
    pool: string;
  }

  export interface IncreaseLiquidityOptions extends MintParams {
    /**
     * NFT ID
     */
    nft: string;
  }

  export interface DecreaseLiquidityOptions extends MintParams {
    /**
     * NFT ID
     */
    nft: string;
  }

  /**
   * Pool fields from `provider.getObject()` while turning on `showContent` option.
   */
  export interface PoolFields {
    coin_a: string;
    coin_b: string;
    deploy_time_ms: string;
    fee: number;
    fee_growth_global_a: string;
    fee_growth_global_b: string;
    fee_protocol: number;
    id: { id: string };
    liquidity: string;
    max_liquidity_per_tick: string;
    protocol_fees_a: string;
    protocol_fees_b: string;
    reward_infos: any[];
    reward_last_updated_time_ms: string;
    sqrt_price: string;
    tick_current_index: {
      type: string;
      fields: { bits: number };
    };
    tick_map: {
      type: string;
      fields: {
        id: { id: string };
        size: string;
      };
    };
    tick_spacing: number;
    unlocked: boolean;
    version: string;
  }
}

export class Pool extends Base {
  async createPool(
    options: Pool.CreatePoolOptions,
  ): Promise<SuiTransactionBlockResponse> {
    const {
      fee,
      address,
      minPrice,
      maxPrice,
      currentPrice,
      slippage,
      signAndExecute,
      amount,
      coins,
    } = options;
    const contract = this.contract.config;
    const [coinTypeA, coinTypeB] = coins;
    const [amountA, amountB] = amount;
    const [coinA, coinB] = await Promise.all([
      this.provider.getCoinMetadata({ coinType: coinTypeA }),
      this.provider.getCoinMetadata({ coinType: coinTypeB }),
    ]);
    if (!coinA || !coinB) throw new Error('Invalid coin type');
    const currentSqrtPrice = this.math.priceToSqrtPriceX64(
      currentPrice,
      coinA.decimals,
      coinB.decimals,
    );
    const minTick = this.getTickIndex(minPrice, coinA, coinB, fee);
    const maxTick = this.getTickIndex(maxPrice, coinA, coinB, fee);
    const bigAmountA = this.math.scaleUp(amountA, coinA.decimals);
    const bigAmountB = this.math.scaleUp(amountB, coinB.decimals);
    const [coinIdsA, coinIdsB] = await Promise.all([
      this.coin.selectTradeCoins(address, coinTypeA, bigAmountA),
      this.coin.selectTradeCoins(address, coinTypeB, bigAmountB),
    ]);

    const txb = new TransactionBlock();
    txb.moveCall({
      target: `${contract.packageId}::pool_factory::deploy_pool_and_mint`,
      typeArguments: [coinTypeA, coinTypeB, fee.type],
      arguments: [
        // pool_config
        txb.object(contract.poolConfig),
        // fee_type?
        txb.object(fee.objectId),
        // sqrt_price
        txb.pure(currentSqrtPrice.toString(), 'u128'),
        // positions
        txb.object(contract.positions),
        // coins
        txb.makeMoveVec({
          objects: this.coin.convertTradeCoins(txb, coinIdsA, coinTypeA, bigAmountA),
        }),
        txb.makeMoveVec({
          objects: this.coin.convertTradeCoins(txb, coinIdsB, coinTypeB, bigAmountB),
        }),
        // tick_lower_index
        txb.pure(Math.abs(minTick).toFixed(0), 'u32'),
        txb.pure(minTick < 0, 'bool'),
        // tick_upper_index
        txb.pure(Math.abs(maxTick).toFixed(0), 'u32'),
        txb.pure(maxTick < 0, 'bool'),
        // amount_desired
        txb.pure(bigAmountA.toFixed(0), 'u64'),
        txb.pure(bigAmountB.toFixed(0), 'u64'),
        // amount_min
        txb.pure(this.getMinimumAmountBySlippage(bigAmountA, slippage), 'u64'),
        txb.pure(this.getMinimumAmountBySlippage(bigAmountB, slippage), 'u64'),
        // recipient
        txb.object(address),
        // deadline
        txb.pure(Date.now() + ONE_MINUTE, 'u64'),
        // clock
        txb.object(SUI_CLOCK_OBJECT_ID),
        // versioned
        txb.object(contract.versioned),
      ],
    });

    return signAndExecute(txb, this.provider);
  }

  async addLiquidity(
    options: Pool.AddLiquidityOptions,
  ): Promise<SuiTransactionBlockResponse> {
    const {
      address,
      amount: [amountA, amountB],
      minPrice,
      maxPrice,
      slippage,
      signAndExecute,
      pool,
    } = options;
    const contract = this.contract.config;
    const typeArguments = await this.getPoolTypeArguments(pool);
    const [coinTypeA, coinTypeB, feeType] = typeArguments;
    const [coinA, coinB] = await Promise.all([
      this.provider.getCoinMetadata({ coinType: coinTypeA }),
      this.provider.getCoinMetadata({ coinType: coinTypeB }),
    ]);
    if (!coinA || !coinB) throw new Error('Invalid coin type');
    const txb = new TransactionBlock();
    const bigAmountA = this.math.scaleUp(amountA, coinA.decimals);
    const bigAmountB = this.math.scaleUp(amountB, coinB.decimals);
    const [coinIdsA, coinIdsB] = await Promise.all([
      this.coin.selectTradeCoins(address, coinTypeA, bigAmountA),
      this.coin.selectTradeCoins(address, coinTypeB, bigAmountB),
    ]);

    const fees = await this.contract.getFees();
    const fee = fees.find((item) => item.type === feeType)!;
    const minTick = this.getTickIndex(minPrice, coinA, coinB, fee);
    const maxTick = this.getTickIndex(maxPrice, coinA, coinB, fee);

    txb.moveCall({
      target: `${contract.packageId}::position_manager::mint`,
      typeArguments: typeArguments,
      arguments: [
        // pool
        txb.object(pool),
        // positions
        txb.object(contract.positions),
        // coins
        txb.makeMoveVec({
          objects: this.coin.convertTradeCoins(txb, coinIdsA, coinTypeA, bigAmountA),
        }),
        txb.makeMoveVec({
          objects: this.coin.convertTradeCoins(txb, coinIdsB, coinTypeB, bigAmountB),
        }),
        // tick_lower_index
        txb.pure(Math.abs(minTick).toFixed(0), 'u32'),
        txb.pure(minTick < 0, 'bool'),
        // tick_upper_index
        txb.pure(Math.abs(maxTick).toFixed(0), 'u32'),
        txb.pure(maxTick < 0, 'bool'),
        // amount_desired
        txb.pure(bigAmountA.toFixed(0), 'u64'),
        txb.pure(bigAmountB.toFixed(0), 'u64'),
        // amount_min
        txb.pure(this.getMinimumAmountBySlippage(bigAmountA, slippage), 'u64'),
        txb.pure(this.getMinimumAmountBySlippage(bigAmountB, slippage), 'u64'),
        // recipient
        txb.object(address),
        // deadline
        txb.pure(Date.now() + ONE_MINUTE, 'u64'),
        // clock
        txb.object(SUI_CLOCK_OBJECT_ID),
        // versioned
        txb.object(contract.versioned),
      ],
    });

    return signAndExecute(txb, this.provider);
  }

  async increaseLiquidity(options: Pool.IncreaseLiquidityOptions) {
    const {
      amount: [amountA, amountB],
      slippage,
      nft,
      signAndExecute,
    } = options;
    const contract = this.contract.config;
    const [{ pool_id: pool }, address] = await Promise.all([
      this.nft.getFields(nft),
      this.nft.getOwner(nft),
    ]);
    if (!address) throw new Error('Missing owner from nft: ' + nft);
    const typeArguments = await this.getPoolTypeArguments(pool);
    const [coinTypeA, coinTypeB] = typeArguments;
    const [coinA, coinB] = await Promise.all([
      this.provider.getCoinMetadata({ coinType: coinTypeA }),
      this.provider.getCoinMetadata({ coinType: coinTypeB }),
    ]);
    if (!coinA || !coinB) throw new Error('Invalid coin type');
    const bigAmountA = this.math.scaleUp(amountA, coinA.decimals);
    const bigAmountB = this.math.scaleUp(amountB, coinB.decimals);
    const [coinIdsA, coinIdsB] = await Promise.all([
      this.coin.selectTradeCoins(address, coinTypeA, bigAmountA),
      this.coin.selectTradeCoins(address, coinTypeB, bigAmountB),
    ]);

    const txb = new TransactionBlock();
    txb.moveCall({
      target: `${contract.packageId}::position_manager::increase_liquidity`,
      typeArguments: typeArguments,
      arguments: [
        // pool
        txb.object(pool),
        // positions
        txb.object(contract.positions),
        // coins
        txb.makeMoveVec({
          objects: this.coin.convertTradeCoins(txb, coinIdsA, coinTypeA, bigAmountA),
        }),
        txb.makeMoveVec({
          objects: this.coin.convertTradeCoins(txb, coinIdsB, coinTypeB, bigAmountB),
        }),
        // nft
        txb.object(nft),
        // amount_desired
        txb.pure(bigAmountA.toFixed(0), 'u64'),
        txb.pure(bigAmountB.toFixed(0), 'u64'),
        // amount_min
        txb.pure(this.getMinimumAmountBySlippage(bigAmountA, slippage), 'u64'),
        txb.pure(this.getMinimumAmountBySlippage(bigAmountB, slippage), 'u64'),
        // deadline
        txb.pure(Date.now() + ONE_MINUTE * 3, 'u64'),
        // clock
        txb.object(SUI_CLOCK_OBJECT_ID),
        // versioned
        txb.object(contract.versioned),
      ],
    });
    return signAndExecute(txb, this.provider);
  }

  async decreaseLiquidity(
    options: Pool.DecreaseLiquidityOptions,
  ): Promise<SuiTransactionBlockResponse> {
    const {
      amount: [amountA, amountB],
      slippage,
      nft,
      signAndExecute,
    } = options;
    const contract = this.contract.config;
    const [{ pool_id: pool }, { liquidity }] = await Promise.all([
      this.nft.getFields(nft),
      this.nft.getPositionFields(nft),
    ]);
    const typeArguments = await this.getPoolTypeArguments(pool);
    const [coinTypeA, coinTypeB] = typeArguments;
    const [coinA, coinB] = await Promise.all([
      this.provider.getCoinMetadata({ coinType: coinTypeA }),
      this.provider.getCoinMetadata({ coinType: coinTypeB }),
    ]);
    if (!coinA || !coinB) throw new Error('Invalid coin type');
    const bigAmountA = this.math.scaleUp(amountA, coinA.decimals);
    const bigAmountB = this.math.scaleUp(amountB, coinB.decimals);

    const txb = new TransactionBlock();
    txb.moveCall({
      target: `${contract.packageId}::position_manager::decrease_liquidity`,
      typeArguments: typeArguments,
      arguments: [
        // pool
        txb.object(pool),
        // positions
        txb.object(contract.positions),
        // nft
        txb.object(nft),
        // liquidity
        txb.pure(liquidity, 'u128'),
        // amount_min
        txb.pure(this.getMinimumAmountBySlippage(bigAmountA, slippage), 'u64'),
        txb.pure(this.getMinimumAmountBySlippage(bigAmountB, slippage), 'u64'),
        // deadline
        txb.pure(Date.now() + ONE_MINUTE * 3, 'u64'),
        // clock
        txb.object(SUI_CLOCK_OBJECT_ID),
        // versioned
        txb.object(contract.versioned),
      ],
    });
    return signAndExecute(txb, this.provider);
  }

  public getTokenAmountsFromLiquidity(options: {
    currentSqrtPrice: BN;
    lowerSqrtPrice: BN;
    upperSqrtPrice: BN;
    /**
     * Defaults `BN(100_000_000)`
     */
    liquidity?: BN;
    /**
     * Defaults `true`
     */
    ceil?: boolean;
  }): [a: BN, b: BN] {
    const liquidity = new Decimal((options.liquidity || new BN(100_000_000)).toString());
    const currentPrice = new Decimal(options.currentSqrtPrice.toString());
    const lowerPrice = new Decimal(options.lowerSqrtPrice.toString());
    const upperPrice = new Decimal(options.upperSqrtPrice.toString());
    let amountA: Decimal, amountB: Decimal;

    if (options.currentSqrtPrice.lt(options.lowerSqrtPrice)) {
      // x = L * (pb - pa) / (pa * pb)
      amountA = this.math
        .toX64_Decimal(liquidity)
        .mul(upperPrice.sub(lowerPrice))
        .div(lowerPrice.mul(upperPrice));
      amountB = new Decimal(0);
    } else if (options.currentSqrtPrice.lt(options.upperSqrtPrice)) {
      // x = L * (pb - p) / (p * pb)
      // y = L * (p - pa)
      amountA = this.math
        .toX64_Decimal(liquidity)
        .mul(upperPrice.sub(currentPrice))
        .div(currentPrice.mul(upperPrice));
      amountB = this.math.fromX64_Decimal(liquidity.mul(currentPrice.sub(lowerPrice)));
    } else {
      // y = L * (pb - pa)
      amountA = new Decimal(0);
      amountB = this.math.fromX64_Decimal(liquidity.mul(upperPrice.sub(lowerPrice)));
    }

    const methodName = options.ceil !== false ? 'ceil' : 'floor';
    return [
      new BN(amountA[methodName]().toString()),
      new BN(amountB[methodName]().toString()),
    ];
  }

  protected getMinimumAmountBySlippage(
    amount: Decimal.Value,
    slippage: Decimal.Value,
  ): string {
    const origin = new Decimal(amount);
    const ratio = new Decimal(1).minus(new Decimal(slippage).div(100));
    if (ratio.lte(0) || ratio.gt(1)) {
      throw new Error('invalid slippage range');
    }
    return origin.mul(ratio).toFixed(0);
  }

  protected getPoolTypeArguments(poolId: string): Promise<[string, string, string]> {
    return this.getCacheOrSet('pool-type', async () => {
      const result = await this.provider.getObject({
        id: poolId,
        options: { showType: true },
      });
      validateObjectResponse(result, 'pool');
      return this.parsePoolType(getObjectType(result)!);
    });
  }

  protected parsePoolType(type: string): [string, string, string] {
    const matched = type.match(/(\w+::\w+::\w+)/g);
    if (!matched || matched.length !== 4) {
      throw new Error('Invalid pool type');
    }
    return [matched[1]!, matched[2]!, matched[3]!];
  }

  protected getTickIndex(
    price: Decimal.Value,
    coinA: CoinMetadata,
    coinB: CoinMetadata,
    fee: Contract.Fee,
  ) {
    let tick = this.math.priceToTickIndex(price, coinA.decimals, coinB.decimals);
    tick -= tick % fee.tickSpacing;
    return tick;
  }
}
