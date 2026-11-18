export function sameDeliveryRevision(left, right) {
  return Boolean(left && right
    && left.baseOid === right.baseOid
    && left.headOid === right.headOid
    && left.targetOid === right.targetOid
    && left.candidateOid === right.candidateOid
    && left.digest === right.digest);
}
