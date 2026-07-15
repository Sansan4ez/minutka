import * as Minio from "minio";

export type MinioConfig = {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
};

/** Loads object-storage settings only when personal-vault storage is composed. */
export function minioConfigFromEnv(env: NodeJS.ProcessEnv): MinioConfig {
  const endpoint = required(env, "MINIO_ENDPOINT");
  const accessKey = required(env, "MINIO_ACCESS_KEY");
  const secretKey = required(env, "MINIO_SECRET_KEY");
  const bucket = required(env, "MINIO_BUCKET");
  const port = Number(env.MINIO_PORT ?? "9000");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MINIO_PORT must be a valid TCP port");
  const useSSL = env.MINIO_USE_SSL === "true";
  return { endpoint, port, useSSL, accessKey, secretKey, bucket };
}

export function createMinioClient(config: MinioConfig): Minio.Client {
  return new Minio.Client({ endPoint: config.endpoint, port: config.port, useSSL: config.useSSL, accessKey: config.accessKey, secretKey: config.secretKey });
}

/**
 * Verifies the bucket prepared by infrastructure bootstrap. The runtime uses a
 * least-privilege application account, so it must not create buckets or alter
 * their versioning configuration.
 */
export async function prepareMinioBucket(client: Minio.Client, bucket: string): Promise<void> {
  if (!await client.bucketExists(bucket)) throw new Error(`MinIO bucket ${bucket} is not provisioned`);
  if ((await client.getBucketVersioning(bucket)).Status !== "Enabled") throw new Error(`MinIO bucket ${bucket} must have versioning enabled`);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
