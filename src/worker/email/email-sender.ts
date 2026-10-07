export type EmailMessage = {
  to: string[];
  subject: string;
  text: string;
  metadata?: Record<string, string>;
};

export type EmailSender = {
  send(message: EmailMessage): Promise<void>;
};
