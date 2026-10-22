import {
  ApiSuccessSchema,
  CompositionViewSchema,
  type CompositionView,
  type ConfirmCommand,
  type ResumeCommand,
  type SubmitCommand,
} from "@dmall/contracts";
import { parseResponse } from "../../api.js";

type WriteOptions = { csrfToken: string; idempotencyKey: string };

async function write(path: string, command: SubmitCommand | ConfirmCommand | ResumeCommand, options: WriteOptions): Promise<CompositionView> {
  const response = await fetch(`/api/v1/compositions/${path}`, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": options.csrfToken,
      "idempotency-key": options.idempotencyKey,
    },
    body: JSON.stringify(command),
  });
  return (await parseResponse(response, ApiSuccessSchema(CompositionViewSchema))).data;
}

export const composerApi = {
  submit: (command: SubmitCommand, options: WriteOptions) => write("submit", command, options),
  confirm: (command: ConfirmCommand, options: WriteOptions) => write("confirm", command, options),
  resumeDelivery: (command: ResumeCommand, options: WriteOptions) =>
    write(`${encodeURIComponent(command.contentId)}/resume-delivery`, command, options),
  async read(contentId: string): Promise<CompositionView> {
    const response = await fetch(`/api/v1/compositions/${encodeURIComponent(contentId)}`, { credentials: "same-origin" });
    return (await parseResponse(response, ApiSuccessSchema(CompositionViewSchema))).data;
  },
};

export function compositionQuery(contentId: string) {
  return {
    queryKey: ["composition", contentId] as const,
    queryFn: () => composerApi.read(contentId),
    retry: false,
  };
}
