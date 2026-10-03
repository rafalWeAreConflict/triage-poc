export type FormDefinition = {
  name: string;
  slug: string;
  description: string;
  status: string;
  version: number;
  schema: Record<string, unknown>;
  formType?: string;
  isPublic?: boolean;
  publishedAt: string | null;
  createdAt: string;
  updatedAt: string;
  submissionCount: number;
};

export type FormDefinitionsData = {
  formDefinitions: FormDefinition[];
};
