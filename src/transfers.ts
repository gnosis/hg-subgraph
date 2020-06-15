import { Address, BigInt, Bytes } from '@graphprotocol/graph-ts';

import {
  TransferSingle,
  TransferBatch
} from '../generated/ConditionalTokens/ConditionalTokens';

import { UserPosition } from '../generated/schema';

import { bigIntToBytes32, concat, zeroAsBigInt, touchUser } from './utils';

function recordUserPositionChange(
  userAddress: Address,
  userId: string,
  positionIdBytes: Bytes,
  value: BigInt,
  isCredit: boolean,
): void {
  let userPositionId = concat(userAddress, positionIdBytes) as Bytes;
  let userPosition = UserPosition.load(userPositionId.toHex());
  if (userPosition == null) {
    userPosition = new UserPosition(userPositionId.toHex());
    userPosition.user = userId;
    userPosition.balance = zeroAsBigInt;
    userPosition.position = positionIdBytes.toHex();
  }

  if (isCredit) {
    userPosition.balance = userPosition.balance.plus(value);
  } else {
    userPosition.balance = userPosition.balance.minus(value);
  }

  userPosition.save();
}

function recordTransfer(
  from: Address,
  fromId: string,
  to: Address,
  toId: string,
  id: BigInt,
  value: BigInt,
): void {
  let positionIdBytes = bigIntToBytes32(id);
  recordUserPositionChange(from, fromId, positionIdBytes, value, false);
  recordUserPositionChange(to, toId, positionIdBytes, value, true);
}

export function handleTransferSingle(event: TransferSingle): void {
  let params = event.params;
  let from = params.from;
  let to = params.to;
  let blockTimestamp = event.block.timestamp;

  if (
    from.toHex() == '0x0000000000000000000000000000000000000000' ||
    to.toHex() == '0x0000000000000000000000000000000000000000'
  ) return;

  let fromUser = touchUser(from, blockTimestamp);
  let toUser = touchUser(to, blockTimestamp);

  recordTransfer(from, fromUser.id, to, toUser.id, params.id, params.value);
}

export function handleTransferBatch(event: TransferBatch): void {
  let params = event.params;
  let from = params.from;
  let to = params.to;
  let blockTimestamp = event.block.timestamp;

  if (
    from.toHex() == '0x0000000000000000000000000000000000000000' ||
    to.toHex() == '0x0000000000000000000000000000000000000000'
  ) return;

  let fromUser = touchUser(from, blockTimestamp);
  let toUser = touchUser(to, blockTimestamp);

  let ids = params.ids;
  let values = params.values;

  for (let i = 0; i < ids.length; i++) {
    recordTransfer(from, fromUser.id, to, toUser.id, ids[i], values[i]);
  }
}
