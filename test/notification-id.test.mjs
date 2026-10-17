import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cardFromNotificationId, notificationId } from '../desktop/notification-id.mjs';

test("a notification's id names its card", () => {
  assert.equal(cardFromNotificationId(notificationId(754, 123456)), 754);
  assert.equal(cardFromNotificationId('3F2504E0-4F89-11D3-9A0C-0305E82C3301'), undefined);
  assert.equal(cardFromNotificationId(undefined), undefined);
});
