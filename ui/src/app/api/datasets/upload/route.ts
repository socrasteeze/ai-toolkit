// src/app/api/datasets/upload/route.ts
import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import { getDatasetsRoot } from '@/server/settings';
import { findCaseInsensitiveNameCollision, resolveDatasetPath, sanitizeDatasetName } from '@/server/datasetFiles';

export async function POST(request: NextRequest) {
  try {
    const datasetsPath = await getDatasetsRoot();
    if (!datasetsPath) {
      return NextResponse.json({ error: 'Datasets path not found' }, { status: 500 });
    }
    const formData = await request.formData();
    const files = formData.getAll('files');
    const datasetName = formData.get('datasetName');

    const uploadDir = resolveDatasetPath(datasetsPath, datasetName);
    if (!uploadDir) {
      return NextResponse.json({ error: 'Invalid dataset name' }, { status: 400 });
    }

    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 });
    }

    const uploads = files.map(entry => {
      if (typeof entry === 'string') return null;
      const fileName = entry.name.replace(/[^a-zA-Z0-9.-]/g, '_');
      const safeFileName = sanitizeDatasetName(fileName);
      const filePath = safeFileName ? resolveDatasetPath(uploadDir, safeFileName) : null;
      return safeFileName && filePath ? { file: entry, fileName: safeFileName, filePath } : null;
    });
    if (uploads.some(upload => upload === null)) {
      return NextResponse.json({ error: 'Invalid file name' }, { status: 400 });
    }
    const validUploads = uploads.filter(upload => upload !== null);
    const collision = findCaseInsensitiveNameCollision(validUploads.map(upload => upload.fileName));
    if (collision) {
      return NextResponse.json(
        { error: `File names collide after sanitization: ${collision[0]} and ${collision[1]}` },
        { status: 400 },
      );
    }

    // Create upload directory if it doesn't exist
    await mkdir(uploadDir, { recursive: true });

    const savedFiles: string[] = [];

    // Process files sequentially to avoid overwhelming the system
    for (const upload of validUploads) {
      const { file, fileName, filePath } = upload;
      const bytes = await file.arrayBuffer();
      const buffer = Buffer.from(bytes);

      await writeFile(filePath, buffer);
      savedFiles.push(fileName);
    }

    return NextResponse.json({
      message: 'Files uploaded successfully',
      files: savedFiles,
    });
  } catch (error) {
    console.error('Upload error:', error);
    return NextResponse.json({ error: 'Error uploading files' }, { status: 500 });
  }
}

// Increase payload size limit (default is 4mb)
export const config = {
  api: {
    bodyParser: false,
    responseLimit: '50mb',
  },
};
