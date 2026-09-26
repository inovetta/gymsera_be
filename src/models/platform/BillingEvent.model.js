const { DataTypes } = require('sequelize');

/**
 * Inbox of every incoming provider billing event — App Store Server
 * Notifications, Google Play RTDN (Pub/Sub push) and Stripe webhooks (spec
 * §7.6, BILL-12).
 *
 * A webhook handler only verifies the sender and INSERTs a row here; the
 * processor (billing-event.service.js) then re-fetches the provider's current
 * truth and applies it through the same sync function the app's /sync calls.
 *
 * `(provider, providerEventId)` is unique, so a provider redelivering the same
 * event is a no-op once it has been processed. A row that failed to process
 * stays FAILED with its error and attempt count, and the sweep retries it —
 * the event is never lost just because the database or the provider API
 * hiccuped at the moment it arrived.
 */
module.exports = (sequelize) => {
  return sequelize.define(
    'BillingEvent',
    {
      id: {
        type: DataTypes.UUID,
        defaultValue: DataTypes.UUIDV4,
        primaryKey: true,
      },
      provider: {
        type: DataTypes.ENUM('APPLE', 'GOOGLE', 'STRIPE'),
        allowNull: false,
      },
      providerEventId: {
        type: DataTypes.STRING(191),
        allowNull: false,
        comment: "Apple notificationUUID, Pub/Sub messageId, or Stripe event id — the provider's own dedupe key.",
      },
      eventType: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      rawPayload: {
        type: DataTypes.TEXT('long'),
        allowNull: false,
        comment: 'Exactly what the provider sent (after signature verification), kept so the sweep can reprocess it.',
      },
      status: {
        type: DataTypes.ENUM('RECEIVED', 'PROCESSED', 'IGNORED', 'FAILED'),
        allowNull: false,
        defaultValue: 'RECEIVED',
      },
      attempts: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 0,
      },
      lastError: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      receivedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      processedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'billing_events',
      underscored: true,
      timestamps: true,
      indexes: [
        { unique: true, fields: ['provider', 'provider_event_id'], name: 'billing_events_provider_event' },
        { fields: ['status'] },
      ],
    }
  );
};
