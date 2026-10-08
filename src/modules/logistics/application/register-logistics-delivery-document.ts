export type LogisticsDeliveryDocumentType = "COMPROVANTE_ENTREGA" | "TERMO_ACEITE" | "OUTRO";

export type LogisticsDeliveryDocumentFileMetadataInput = {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
  uploadedByUserId: string;
};

export type RegisterLogisticsDeliveryDocumentInput = {
  commandId: string;
  deliveryId: string;
  documentType: LogisticsDeliveryDocumentType;
  documentNumber?: string;
  documentDate?: Date;
  issuerName?: string;
  file?: LogisticsDeliveryDocumentFileMetadataInput;
  notes?: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId?: string;
};

export type LogisticsDeliveryDocumentFileMetadataCommand = {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  storageKey: string;
  sha256: string;
  uploadedByUserId: string;
};

export type RegisterLogisticsDeliveryDocumentCommand = {
  commandId: string;
  deliveryId: string;
  documentType: LogisticsDeliveryDocumentType;
  documentNumber?: string;
  documentDate?: Date;
  issuerName?: string;
  file?: LogisticsDeliveryDocumentFileMetadataCommand;
  notes?: string;
  actorUserId?: string;
  teamContext?: string;
  correlationId: string;
};

export type RegisterLogisticsDeliveryDocumentFailureReason =
  | "INVALID_COMMAND_ID"
  | "INVALID_DELIVERY_ID"
  | "INVALID_DOCUMENT_TYPE"
  | "INVALID_DOCUMENT_NUMBER"
  | "INVALID_DOCUMENT_DATE"
  | "INVALID_ISSUER_NAME"
  | "INVALID_FILE_METADATA"
  | "INVALID_NOTES"
  | "IDEMPOTENCY_KEY_CONFLICT"
  | "DELIVERY_NOT_FOUND"
  | "DUPLICATE_STORAGE_KEY";

export type RegisterLogisticsDeliveryDocumentResult =
  | {
      ok: true;
      documentId: string;
      deliveryId: string;
      documentType: LogisticsDeliveryDocumentType;
    }
  | {
      ok: false;
      reason: RegisterLogisticsDeliveryDocumentFailureReason;
      deliveryId?: string;
    };

export type LogisticsDeliveryDocumentRegistrar = {
  register(
    input: RegisterLogisticsDeliveryDocumentCommand
  ): Promise<RegisterLogisticsDeliveryDocumentResult>;
};

const DOCUMENT_TYPES = new Set<LogisticsDeliveryDocumentType>([
  "COMPROVANTE_ENTREGA",
  "TERMO_ACEITE",
  "OUTRO"
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export class RegisterLogisticsDeliveryDocument {
  constructor(private readonly registrar: LogisticsDeliveryDocumentRegistrar) {}

  async execute(
    input: RegisterLogisticsDeliveryDocumentInput
  ): Promise<RegisterLogisticsDeliveryDocumentResult> {
    const commandId = input.commandId.trim();
    const deliveryId = input.deliveryId.trim();
    const documentNumber = normalizeOptionalString(input.documentNumber);
    const issuerName = normalizeOptionalString(input.issuerName);
    const notes = normalizeOptionalString(input.notes);
    const file = normalizeFileMetadata(input.file);

    if (commandId.length === 0) {
      return { ok: false, reason: "INVALID_COMMAND_ID" };
    }

    if (deliveryId.length === 0) {
      return { ok: false, reason: "INVALID_DELIVERY_ID" };
    }

    if (!DOCUMENT_TYPES.has(input.documentType)) {
      return { ok: false, reason: "INVALID_DOCUMENT_TYPE", deliveryId };
    }

    if (documentNumber === null) {
      return { ok: false, reason: "INVALID_DOCUMENT_NUMBER", deliveryId };
    }

    if (input.documentDate !== undefined && Number.isNaN(input.documentDate.getTime())) {
      return { ok: false, reason: "INVALID_DOCUMENT_DATE", deliveryId };
    }

    if (issuerName === null) {
      return { ok: false, reason: "INVALID_ISSUER_NAME", deliveryId };
    }

    if (notes === null || file === null) {
      return {
        ok: false,
        reason: file === null ? "INVALID_FILE_METADATA" : "INVALID_NOTES",
        deliveryId
      };
    }

    return this.registrar.register({
      commandId,
      deliveryId,
      documentType: input.documentType,
      documentNumber,
      documentDate: input.documentDate,
      issuerName,
      file,
      notes,
      actorUserId: input.actorUserId,
      teamContext: input.teamContext,
      correlationId: input.correlationId?.trim() || commandId
    });
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function normalizeFileMetadata(
  file: LogisticsDeliveryDocumentFileMetadataInput | undefined
): LogisticsDeliveryDocumentFileMetadataCommand | undefined | null {
  if (file === undefined) {
    return undefined;
  }

  const fileName = file.fileName.trim();
  const contentType = file.contentType.trim();
  const storageKey = file.storageKey.trim();
  const sha256 = file.sha256.trim();
  const uploadedByUserId = file.uploadedByUserId.trim();

  if (
    fileName.length === 0 ||
    contentType.length === 0 ||
    storageKey.length === 0 ||
    uploadedByUserId.length === 0 ||
    !Number.isSafeInteger(file.sizeBytes) ||
    file.sizeBytes <= 0 ||
    !SHA256_PATTERN.test(sha256)
  ) {
    return null;
  }

  return {
    fileName,
    contentType,
    sizeBytes: file.sizeBytes,
    storageKey,
    sha256,
    uploadedByUserId
  };
}
