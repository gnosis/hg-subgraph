import { Bytes, log } from '@graphprotocol/graph-ts';

import {
  TransferSingle,
  TransferBatch
} from './types/ConditionalTokens/ConditionalTokens';

import { User, Position, UserPosition } from './types/schema';

import { bigIntToBytes32, concat, checkIfValueExistsInArray, zeroAsBigInt } from './utils';

export function handleTransferSingle(event: TransferSingle): void {
  let params = event.params;

  if (
    params.from.toHex() == '0x0000000000000000000000000000000000000000' ||
    params.to.toHex() == '0x0000000000000000000000000000000000000000'
  ) return;

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
  toUser.lastActive = event.block.timestamp;
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
}

export function handleTransferBatch(event: TransferBatch): void {
  let params = event.params;

  if (
    params.from.toHex() == '0x0000000000000000000000000000000000000000' ||
    params.to.toHex() == '0x0000000000000000000000000000000000000000'
  ) return;

  // User Section
  let fromUser = User.load(params.from.toHex());
  if (fromUser == null) {
    fromUser = new User(params.from.toHex());
    fromUser.firstParticipation = event.block.timestamp;
    fromUser.participatedConditions = [];
  }
  fromUser.lastActive = event.block.timestamp;
  fromUser.save();
  let toUser = User.load(params.to.toHex());
  if (toUser == null) {
    toUser = new User(params.to.toHex());
    toUser.firstParticipation = event.block.timestamp;
    toUser.participatedConditions = [];
  }
  toUser.lastActive = event.block.timestamp;
  toUser.save();

  let positionIds = params.ids;
  let transferValues = params.values;

  for (var i = 0; i < params.ids.length; i++) {
    let positionId = positionIds[i];
    let transferValue = transferValues[i];
    let clonedPosition = Position.load(positionId.toHex());
    if (clonedPosition == null) {
      log.error("could not load position {}", [positionId.toHex()])
    } else {
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
    }

    // from UserPosition Section
    let bytesPositionId = bigIntToBytes32(positionId);
    let fromUserPositionId = concat(params.from, bytesPositionId) as Bytes;
    let fromUserPosition = UserPosition.load(fromUserPositionId.toHex());
    if (fromUserPosition == null) {
      fromUserPosition = new UserPosition(fromUserPositionId.toHex());
      fromUserPosition.user = fromUser.id;
      let position = Position.load(bytesPositionId.toHex());
      fromUserPosition.position = position.id;
      fromUserPosition.balance = zeroAsBigInt;
    }
    fromUserPosition.balance = fromUserPosition.balance.minus(transferValue);
    fromUserPosition.save();
    // to UserPosition Section
    let toUserPositionId = concat(params.to, bytesPositionId) as Bytes;
    let toUserPosition = UserPosition.load(toUserPositionId.toHex());
    if (toUserPosition == null) {
      toUserPosition = new UserPosition(toUserPositionId.toHex());
      toUserPosition.user = toUser.id;
      let position = Position.load(bytesPositionId.toHex());
      toUserPosition.position = position.id;
      toUserPosition.balance = zeroAsBigInt;
    }
    toUserPosition.balance = toUserPosition.balance.plus(transferValue);
    toUserPosition.save();
  }
}
