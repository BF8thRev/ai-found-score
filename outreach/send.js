// Sending is deliberately not implemented here. Nothing in outreach/ can put a
// postcard or email in the mail. Cold email goes through the Worker's Gmail
// sender (src/lib/gmail-sender.js), which calls isSuppressed() before every
// send. A postcard sender (Lob) must do the same, for every recipient.

export async function send() {
  throw new Error('sending not enabled');
}
