require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { DocumentAnalysisClient } = require('@azure/ai-form-recognizer');
const createFaceClient = require("@azure-rest/ai-vision-face").default;
const { AzureKeyCredential } = require("@azure/core-auth");
const cors = require('cors');

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());

// Azure Services Setup
const formRecognizerClient = new DocumentAnalysisClient(
  process.env.FORM_RECOGNIZER_ENDPOINT,
  new AzureKeyCredential(process.env.FORM_RECOGNIZER_KEY)
);

const faceClient = createFaceClient(
  process.env.FACE_API_ENDPOINT,
  new AzureKeyCredential(process.env.FACE_API_KEY)
);

// Configure multer for file uploads
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ID Verification Endpoint
app.post('/verify-id', upload.single('idImage'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No ID image uploaded' });
    }

    const idBuffer = req.file.buffer;
    const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-idDocument", idBuffer);
    const idResults = await poller.pollUntilDone();

    if (!idResults || idResults.documents.length === 0) {
      return res.status(400).json({ error: 'ID document recognition failed' });
    }

    const { fields } = idResults.documents[0];
    const idData = {
      documentType: fields.idType?.value || 'Unknown',
      idNumber: fields.idNumber?.value || '',
      firstName: fields.firstName?.value || '',
      lastName: fields.lastName?.value || '',
      expiryDate: fields.expiryDate?.value || ''
    };

    // Face verification (optional)
    let faceMatchResult = null;
    if (req.body.enableFaceMatch === 'true' && req.body.faceImage) {
      const faceBuffer = Buffer.from(req.body.faceImage, 'base64');
      const selfieFaceId = await detectFace(faceBuffer);
      const idFaceId = await detectFace(idBuffer);
      if (selfieFaceId && idFaceId) {
        const isIdentical = await verifyFaces(selfieFaceId, idFaceId);
        faceMatchResult = isIdentical ? 'MATCH' : 'NO_MATCH';
      } else {
        faceMatchResult = 'NO_FACE_DETECTED';
      }
    }

    // Environment checks
    const environmentData = {
      ip: req.body.ip || 'Unknown',
      location: req.body.location || 'Unknown',
      vpnDetected: req.body.vpnDetected === 'true',
      audioSource: req.body.audioSource || 'Unknown'
    };

    // Compile verification report
    const verificationReport = {
      timestamp: new Date().toISOString(),
      candidate: `${idData.firstName} ${idData.lastName}`,
      idData,
      faceMatch: faceMatchResult,
      environment: environmentData,
      status: idData.idNumber ? 'VERIFIED' : 'FAILED'
    };

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=verification-report.json');
    res.send(JSON.stringify(verificationReport, null, 2));
  } catch (error) {
    console.error('Verification error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Helper functions
async function detectFace(imageBuffer) {
  const result = await faceClient.path("/detect").post({
    body: imageBuffer,
    headers: {
      "Content-Type": "application/octet-stream"
    },
    queryParameters: {
      "detectionModel": "detection_03",
      "returnFaceId": true
    }
  });
  if (result.status !== 200) throw new Error("Face detection failed");
  return result.body[0]?.faceId;
}

async function verifyFaces(faceId1, faceId2) {
  const result = await faceClient.path("/verify").post({
    body: { faceId1, faceId2 }
  });
  if (result.status !== 200) throw new Error("Face verification failed");
  return result.body.isIdentical;
}

app.listen(port, () => {
  console.log(`✅ Server running on http://localhost:${port}`);
});
