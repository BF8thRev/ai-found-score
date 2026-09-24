// Sending is deliberately not implemented. Nothing in outreach/ can put a
// postcard or email in the mail. When a real sender is wired (email
// provider, Lob), it must call isSuppressed() first, for every recipient.

export async function send() {
  throw new Error('sending not enabled');
}
