import { BigInt } from '@graphprotocol/graph-ts';

import {
  ConditionPreparation,
  ConditionResolution
} from '../generated/ConditionalTokens/ConditionalTokens';

import { Condition } from '../generated/schema';

import { sum } from './utils';

export function handleConditionPreparation(event: ConditionPreparation): void {
  let condition = new Condition(event.params.conditionId.toHex());
  condition.creator = event.transaction.from;
  condition.oracle = event.params.oracle;
  condition.questionId = event.params.questionId;
  condition.outcomeSlotCount = event.params.outcomeSlotCount.toI32();
  condition.resolved = false;
  condition.createTransaction = event.transaction.hash;
  condition.creationTimestamp = event.block.timestamp;
  condition.creationBlockNumber = event.block.number;
  condition.save();
}

export function handleConditionResolution(event: ConditionResolution): void {
  let condition = Condition.load(event.params.conditionId.toHex());
  condition.payoutNumerators = event.params.payoutNumerators;
  let denominator: BigInt = sum(event.params.payoutNumerators);
  condition.payoutDenominator = denominator;
  condition.resolveTransaction = event.transaction.hash;
  condition.resolveTimestamp = event.block.timestamp;
  condition.resolved = true;
  condition.save();
}
