/** The application context handed to every service and route. */
import type pg from 'pg';
import type { PartnerRegistry, MarketSimulator } from '@wealthcard/adapters';
import type { Config } from './config.js';

export interface AppContext {
  readonly config: Config;
  readonly pool: pg.Pool;
  readonly partners: PartnerRegistry;
  readonly market: MarketSimulator;
  /** Injectable clock. Tests freeze it; production passes Date.now. */
  readonly now: () => Date;
}
