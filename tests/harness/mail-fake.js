/**
 * Fake mail sender for tests — no message ever reaches an SMTP server
 * (spec §14 R-19). Replaces email.service.js#mailTransport.send with a jest
 * spy that records each message, the same way billing-fakes.js replaces the
 * Apple / Google / Stripe calls.
 *
 *   const { sent } = installMailFake();
 *   ... code that sends mail ...
 *   expect(sent.map((m) => m.to)).toContain('someone@example.test');
 */
const emailService = require('../../src/services/email.service');

const installMailFake = () => {
  const sent = [];
  const send = jest.spyOn(emailService.mailTransport, 'send').mockImplementation(async (message) => {
    sent.push(message);
    return { messageId: `<fake-${sent.length}@gymsera.test>` };
  });
  return { sent, send };
};

module.exports = { installMailFake };
