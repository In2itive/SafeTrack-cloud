/**
 * Giving provider registry. To add a provider (e.g. our own Stripe module):
 *   1. add its id to the batch_source enum (stripe is already there)
 *   2. file-based: implement FileProvider and list it here
 *      feed-based: write a webhook that calls stage_external_transactions_server
 *      and list a FeedProvider here so its gifts show up for review
 * Matching, posting and controls are shared. See docs/GIVING_PROVIDERS.md.
 */
import type { GivingProvider, ProviderId } from '../types';
import { pushpayProvider } from './pushpay';

export const PROVIDERS: GivingProvider[] = [pushpayProvider];

export const getProvider = (id: ProviderId) => PROVIDERS.find(p => p.id === id);
