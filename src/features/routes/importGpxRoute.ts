import {
  errorCodes,
  isErrorWithCode,
  keepLocalCopy,
  pick,
  types,
} from '@react-native-documents/picker';

import type { GpxRoute } from '../../domain/routes/gpx/GpxRoute';
import {
  GpxValidationError,
  parseGpxRoute,
} from '../../domain/routes/gpx/parseGpxRoute';
import { enrichGpxRouteFromOfflineTerrain } from '../elevation/enrichGpxRouteFromOfflineTerrain';

const MAXIMUM_GPX_FILE_SIZE_BYTES = 20 * 1024 * 1024;

export class GpxImportCanceledError extends Error {
  constructor() {
    super('Pemilihan GPX dibatalkan.');
    this.name = 'GpxImportCanceledError';
  }
}

export async function pickAndImportGpxRoute(): Promise<GpxRoute> {
  try {
    const [selectedDocument] = await pick({
      allowMultiSelection: false,
      mode: 'import',
      type: types.allFiles,
    });

    const sourceFileName = selectedDocument.name ?? 'route.gpx';
    validateSelectedDocument(sourceFileName, selectedDocument.size);

    const [localCopy] = await keepLocalCopy({
      destination: 'cachesDirectory',
      files: [
        {
          fileName: sourceFileName,
          uri: selectedDocument.uri,
        },
      ],
    });

    if (localCopy.status === 'error') {
      throw new GpxValidationError(
        `File GPX tidak dapat disalin: ${localCopy.copyError}`,
      );
    }

    const gpxFileResponse = await fetch(localCopy.localUri);
    const gpxXml = await gpxFileResponse.text();

    const importedRoute = parseGpxRoute(gpxXml, sourceFileName);
    return enrichGpxRouteFromOfflineTerrain(importedRoute);
  } catch (error) {
    if (
      isErrorWithCode(error) &&
      error.code === errorCodes.OPERATION_CANCELED
    ) {
      throw new GpxImportCanceledError();
    }

    throw error;
  }
}

function validateSelectedDocument(fileName: string, fileSize: number | null) {
  if (!fileName.toLowerCase().endsWith('.gpx')) {
    throw new GpxValidationError('Pilih file dengan ekstensi .gpx.');
  }

  if (fileSize !== null && fileSize > MAXIMUM_GPX_FILE_SIZE_BYTES) {
    throw new GpxValidationError('Ukuran GPX melebihi batas 20 MB.');
  }
}
