import { log, BigInt } from '@graphprotocol/graph-ts'
import { Wrapped1155Creation } from '../generated/Wrapped1155Factory/Wrapped1155Factory';
import { Transfer } from '../generated/templates/Wrapped1155/Wrapped1155';
import { Position, UserPosition, WrappedToken } from '../generated/schema'
import { Wrapped1155 } from '../generated/templates'
import { bigIntToBytes32, touchUser, zeroAsBigInt } from './utils';

export function handleWrapped1155Creation(event: Wrapped1155Creation): void {
    if (event.params.multiToken.toHexString() != '{{ConditionalTokens.addressLowerCase}}') return;

    let wrappedTokenAddress = event.params.wrappedToken.toHexString();
    let wrappedToken = new WrappedToken(wrappedTokenAddress);
    let positionId = bigIntToBytes32(event.params.tokenId).toHexString();
    wrappedToken.position = positionId;
    let position = Position.load(positionId)
    if (position != null) {
        position.wrappedTokenAddress = wrappedTokenAddress;
        position.save();
    } else {
        log.error("wrapping unknown position {}", [positionId]);
    }
    wrappedToken.save();

    Wrapped1155.create(event.params.wrappedToken);
}

function recordUserPositionChange(
    userId: string,
    positionId: string,
    value: BigInt,
    isCredit: boolean,
): void {
    let userPositionId = userId + positionId.slice(2);
    log.warning("user position id {} from user {} and position {}", [userPositionId, userId, positionId])
    let userPosition = UserPosition.load(userPositionId);
    if (userPosition == null) {
      userPosition = new UserPosition(userPositionId);
      userPosition.user = userId;
      userPosition.balance = zeroAsBigInt;
      userPosition.wrappedBalance = zeroAsBigInt;
      userPosition.totalBalance = zeroAsBigInt;
      userPosition.position = positionId;
    }

    if (isCredit) {
      userPosition.wrappedBalance = userPosition.wrappedBalance.plus(value);
    } else {
      userPosition.wrappedBalance = userPosition.wrappedBalance.minus(value);
    }
    userPosition.totalBalance = userPosition.balance.plus(userPosition.wrappedBalance);

    userPosition.save();
}

export function handleTransfer(event: Transfer): void {
    let wrappedTokenId = event.address.toHexString();
    let wrappedToken = WrappedToken.load(wrappedTokenId);
    if (wrappedToken == null) {
        log.error('could not find wrapped token for {}', [wrappedTokenId]);
        return;
    }

    let position = Position.load(wrappedToken.position);
    if (position == null) {
        log.error(
            'could not find position {} for wrapped token {}',
            [wrappedToken.position, wrappedTokenId]
        );
        return
    }

    let from = event.params.from;
    let to = event.params.to;
    let value = event.params.value;
    let blockTimestamp = event.block.timestamp;

    let fromUser = touchUser(from, blockTimestamp);
    let toUser = touchUser(to, blockTimestamp);

    recordUserPositionChange(fromUser.id, position.id, value, false);
    recordUserPositionChange(toUser.id, position.id, value, true);
}
