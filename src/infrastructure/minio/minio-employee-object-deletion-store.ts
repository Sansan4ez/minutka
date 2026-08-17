import * as Minio from "minio";
import type { EmployeeObjectDeletionStore } from "../../application/employee-data-deletion.js";
import { assertUserId } from "../../application/document-store.js";

export function createMinioEmployeeObjectDeletionStore(options: {
  client: Minio.Client;
  bucket: string;
}): EmployeeObjectDeletionStore {
  return {
    async deleteByEmployee(employeeId) {
      const prefix = `${assertUserId(employeeId)}/`;
      const versions = await collectVersions(
        options.client.listObjects(options.bucket, prefix, true, { IncludeVersion: true }),
      );
      for (const version of versions) {
        if (!version.name || !version.versionId) {
          throw new Error("employee object version is missing deletion coordinates");
        }
        await options.client.removeObject(options.bucket, version.name, {
          forceDelete: true,
          versionId: version.versionId,
        });
      }
      return { deletedObjectVersions: versions.length };
    },
  };
}

type VersionedObject = { name?: string; versionId?: string };

function collectVersions(stream: NodeJS.ReadableStream): Promise<VersionedObject[]> {
  return new Promise((resolve, reject) => {
    const versions: VersionedObject[] = [];
    stream.on("data", (object: VersionedObject) => versions.push(object));
    stream.once("error", reject);
    stream.once("end", () => resolve(versions));
  });
}
