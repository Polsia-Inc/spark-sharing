const fetch = require('node-fetch');
const FormData = require('form-data');

const R2_UPLOAD_URL = 'https://polsia.com/api/proxy/r2/upload';

async function uploadToR2(fileBuffer, filename, mimeType) {
  const formData = new FormData();
  formData.append('file', fileBuffer, {
    filename,
    contentType: mimeType
  });

  const response = await fetch(R2_UPLOAD_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.POLSIA_API_KEY}`,
      ...formData.getHeaders()
    },
    body: formData
  });

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error?.message || 'Upload failed');
  }
  return result.file;
}

async function deleteFromR2(fileKey) {
  const response = await fetch(`https://polsia.com/api/proxy/r2/files/${encodeURIComponent(fileKey)}`, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${process.env.POLSIA_API_KEY}`
    }
  });
  return response.json();
}

module.exports = { uploadToR2, deleteFromR2 };
