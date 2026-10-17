// A notification's identifier names its card, so a click still finds the card when the
// Notification object is gone (after a restart, from Notification Center's history). What
// changed comes from the server's activity feed (../lib/activity.mjs).

export function notificationId(cardId, now = Date.now()) {
  return `card-${cardId}-${now.toString(36)}`;
}

export function cardFromNotificationId(id) {
  const match = /^card-(\d+)-/.exec(id ?? '');
  return match ? Number(match[1]) : undefined;
}
