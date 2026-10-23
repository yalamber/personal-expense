/**
 * What the family has and owes across its accounts. Cards and loans are owed. A contact's khata
 * is either: positive when they owe us (we have it), negative when we owe them.
 */
export function worth(accounts: { type: string; balanceMinor: number; closedAt?: string | null }[]): { haveMinor: number; oweMinor: number; netMinor: number } {
  let have = 0;
  let owe = 0;
  for (const a of accounts) {
    if (a.closedAt) continue;
    if (a.type === "credit" || a.type === "loan" || (a.type === "person" && a.balanceMinor < 0)) owe -= a.balanceMinor;
    else have += a.balanceMinor;
  }
  return { haveMinor: have, oweMinor: owe, netMinor: have - owe };
}
