import { Bytes, log } from '@graphprotocol/graph-ts';

import {
  TransferSingle,
  TransferBatch
} from '../generated/ConditionalTokens/ConditionalTokens';

import { User, Position, UserPosition } from '../generated/schema';

import { bigIntToBytes32, concat, zeroAsBigInt } from './utils';

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
  }
  fromUser.lastActive = event.block.timestamp;
  fromUser.save();
  let toUser = User.load(params.to.toHex());
  if (toUser == null) {
    toUser = new User(params.to.toHex());
    toUser.firstParticipation = event.block.timestamp;
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
