import { BigInt, Bytes } from '@graphprotocol/graph-ts';

import {
  TransferSingle,
  TransferBatch
} from './types/ConditionalTokens/ConditionalTokens';

import { User, Position, UserPosition, Operator } from './types/schema';

import { bigIntToBytes32, concat, checkIfValueExistsInArray, zeroAsBigInt, sum } from './utils';

export function handleTransferSingle(event: TransferSingle): void {
  let params = event.params;

  // the Position & UserPosition of the from address should already be in the system
  let position = Position.load(bigIntToBytes32(params.id).toHex());
  let fromUserPositionId = concat(params.from, bigIntToBytes32(params.id)) as Bytes;
  let fromUserPosition = UserPosition.load(fromUserPositionId.toHex());
  fromUserPosition.balance = fromUserPosition.balance.minus(params.value);
  fromUserPosition.save();

  // User Section
  let fromUser = User.load(params.from.toHex());
  fromUser.lastActive = event.block.timestamp;
  let toUser = User.load(params.to.toHex());
  if (toUser == null) {
    toUser = new User(params.to.toHex());
    toUser.firstParticipation = event.block.timestamp;
    toUser.participatedConditions = [];
  }
  // Update toUser.participatedConditions
  let clonePositionsConditions = position.conditions;
  for (var q = 0; q < clonePositionsConditions.length; q++) {
    if (
      !checkIfValueExistsInArray(
        toUser.participatedConditions as string[],
        clonePositionsConditions[q]
      )
    ) {
      let toUserParticipatedConditions = toUser.participatedConditions;
      toUserParticipatedConditions[toUserParticipatedConditions.length] =
        clonePositionsConditions[q];
      toUser.participatedConditions = toUserParticipatedConditions;
      toUser.save();
    }
  }
  toUser.lastActive = event.block.timestamp;
  toUser.save();

  // toUser UserPosition Section
  let toUserPositionId = concat(params.to, bigIntToBytes32(params.id)) as Bytes;
  let toUserPosition = UserPosition.load(toUserPositionId.toHex());
  if (toUserPosition == null) {
    toUserPosition = new UserPosition(toUserPositionId.toHex());
    toUserPosition.user = toUser.id;
    toUserPosition.balance = zeroAsBigInt;
    toUserPosition.position = position.id;
  }
  toUserPosition.balance = toUserPosition.balance.plus(params.value);
  toUserPosition.save();

  // Update the Operator
  let operator = Operator.load(params.operator.toHex());
  if (operator == null) {
    operator = new Operator(params.operator.toHex());
    operator.totalValueTransferred = zeroAsBigInt;
    operator.associatedAccounts = [];
    operator.firstParticipation = event.block.timestamp;
    operator.lastActive = event.block.timestamp;
  }
  operator.totalValueTransferred = operator.totalValueTransferred.plus(params.value);
  let clonedOperatorAssociatedAccounts = operator.associatedAccounts;
  if (!checkIfValueExistsInArray(clonedOperatorAssociatedAccounts, params.to.toHex())) {
    clonedOperatorAssociatedAccounts[clonedOperatorAssociatedAccounts.length] = params.to.toHex();
  }
  if (!checkIfValueExistsInArray(clonedOperatorAssociatedAccounts, params.from.toHex())) {
    clonedOperatorAssociatedAccounts[
      clonedOperatorAssociatedAccounts.length
    ] = params.from.toHex();
  }
  operator.lastActive = event.block.timestamp;
  operator.associatedAccounts = clonedOperatorAssociatedAccounts;
  operator.save();
}

export function handleTransferBatch(event: TransferBatch): void {
  let params = event.params;
  let summedValue = sum(params.values);

  // User Section
  let fromUser = User.load(params.from.toHex());
  fromUser.lastActive = event.block.timestamp;
  let toUser = User.load(params.to.toHex());
  if (toUser == null) {
    toUser = new User(params.to.toHex());
    toUser.firstParticipation = event.block.timestamp;
    toUser.participatedConditions = [];
  }
  toUser.lastActive = event.block.timestamp;
  toUser.save();

  // Copies of variables for AssemblyScript memory

  let _positionIds = params.ids;
  let values = params.values;
  let copyPositionIds = new Array<BigInt>(params.ids.length);
  let copyValues = new Array<BigInt>(params.values.length);


  for (var i = 0; i < params.ids.length; i++) {
    copyPositionIds[i] = _positionIds[i];
    copyValues[i] = values[i];

    let clonedPosition = Position.load(copyPositionIds[i].toHex());
    if (!Array.isArray(clonedPosition.conditions)) {
      clonedPosition.conditions = [];
    }

    let clonedPositionConditions = clonedPosition.conditions;
    for (var q = 0; q < clonedPositionConditions.length; q++) {
      if (
        !checkIfValueExistsInArray(
          toUser.participatedConditions as string[],
          clonedPositionConditions[q]
        )
      ) {
        let toUserParticipatedConditions = toUser.participatedConditions;
        toUserParticipatedConditions[toUserParticipatedConditions.length] =
          clonedPositionConditions[q];
        toUser.participatedConditions = toUserParticipatedConditions;
        toUser.save();
      }
    }

    // from UserPosition Section
    let bytesPositionId = bigIntToBytes32(copyPositionIds[i]);
    let fromUserPositionId = concat(params.from, bytesPositionId) as Bytes;
    let fromUserPosition = UserPosition.load(fromUserPositionId.toHex());
    fromUserPosition.balance = fromUserPosition.balance.minus(copyValues[i]);
    fromUserPosition.save();
    // to UserPosition Section
    let toUserPositionId = concat(params.to, bigIntToBytes32(copyPositionIds[i])) as Bytes;
    let toUserPosition = UserPosition.load(toUserPositionId.toHex());
    if (toUserPosition == null) {
      toUserPosition = new UserPosition(toUserPositionId.toHex());
      toUserPosition.user = toUser.id;
      let position = Position.load(bigIntToBytes32(copyPositionIds[i]).toHex());
      toUserPosition.position = position.id;
      toUserPosition.balance = zeroAsBigInt;
    }
    toUserPosition.balance = toUserPosition.balance.plus(copyValues[i]);
    toUserPosition.save();
  }

  // Operator Section
  let operator = Operator.load(params.operator.toHex());
  if (operator == null) {
    operator = new Operator(params.operator.toHex());
    operator.totalValueTransferred = zeroAsBigInt;
    operator.associatedAccounts = [];
    operator.firstParticipation = event.block.timestamp;
    operator.lastActive = event.block.timestamp;
  }
  operator.totalValueTransferred = operator.totalValueTransferred.plus(summedValue);
  let clonedOperatorAssociatedAccounts = operator.associatedAccounts;
  if (!checkIfValueExistsInArray(operator.associatedAccounts as string[], params.to.toHex())) {
    clonedOperatorAssociatedAccounts[operator.associatedAccounts.length] = params.to.toHex();
  }
  if (!checkIfValueExistsInArray(operator.associatedAccounts as string[], params.from.toHex())) {
    clonedOperatorAssociatedAccounts[operator.associatedAccounts.length] = params.from.toHex();
  }
  operator.lastActive = event.block.timestamp;
  operator.associatedAccounts = clonedOperatorAssociatedAccounts;
  operator.save();
}
