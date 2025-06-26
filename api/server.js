require('dotenv').config();
const express = require('express');
const multer = require('multer');
const { DocumentAnalysisClient } = require('@azure/ai-form-recognizer');
const createFaceClient = require("@azure-rest/ai-vision-face").default;
const { AzureKeyCredential } = require("@azure/core-auth");
const cors = require('cors');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 5001;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Azure Clients
const formRecognizerClient = new DocumentAnalysisClient(
  process.env.FORM_RECOGNIZER_ENDPOINT,
  new AzureKeyCredential(process.env.FORM_RECOGNIZER_KEY)
);

const faceClient = createFaceClient(
  process.env.FACE_API_ENDPOINT,
  new AzureKeyCredential(process.env.FACE_API_KEY)
);

// File upload setup
const storage = multer.memoryStorage();
const upload = multer({ storage });

// Main verification route
app.post('/verify-id', upload.single('idImage'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No ID image uploaded' });
    }

    const idBuffer = req.file.buffer;

    // Step 1: Azure Form Recognizer
    const poller = await formRecognizerClient.beginAnalyzeDocument("prebuilt-idDocument", idBuffer);
    const idResults = await poller.pollUntilDone();

    if (!idResults || idResults.documents.length === 0) {
      return res.status(400).json({ error: 'ID document recognition failed' });
    }

    const { fields } = idResults.documents[0];
    console.log("🧾 Extracted fields from Azure:", JSON.stringify(fields, null, 2));

    const idData = {
      documentType: fields['DocumentType']?.value || 'Unknown',
      idNumber: fields['IdNumber']?.value || '',
      firstName: fields['FirstName']?.value || '',
      lastName: fields['LastName']?.value || '',
      expiryDate: fields['DateOfExpiration']?.value || ''
    };

    // Step 2: ID Analyzer (corrected)
    let idAnalyzerResult = null;
    try {
      console.log("🔐 Using ID Analyzer Key:", process.env.ID_ANALYZER_API_KEY?.slice(0, 5) + '...');

      // Base64 encode image (no data URL prefix)
      const base64Document = idBuffer.toString('base64');

      // JSON payload as per ID Analyzer docs
      const payload = {
        document: base64Document
        // profile: 'your-profile-id-if-any' // optional, omit if unknown
      };

      console.log("📡 Sending JSON payload to ID Analyzer at: https://api2.idanalyzer.com/scan");

      const response = await axios.post('https://api2.idanalyzer.com/scan', payload, {
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'X-API-KEY': process.env.ID_ANALYZER_API_KEY
        }
      });

      idAnalyzerResult = response.data;
      console.log("✅ ID Analyzer response:", JSON.stringify(idAnalyzerResult, null, 2));
    } catch (err) {
      console.error("❌ Error calling ID Analyzer:", err?.response?.data || err.message);
      idAnalyzerResult = {
        error: 'ID Analyzer request failed',
        details: err?.response?.data || err.message
      };
    }

    // Step 3: Optional Face Match
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

    // Step 4: Additional Info
    const environmentData = {
      ip: req.body.ip || 'Unknown',
      location: req.body.location || 'Unknown',
      vpnDetected: req.body.vpnDetected === 'true',
      audioSource: req.body.audioSource || 'Unknown'
    };

    // Step 5: Final Output
    const verificationReport = {
      timestamp: new Date().toISOString(),
      candidate: `${idData.firstName} ${idData.lastName}`,
      idData,
      faceMatch: faceMatchResult,
      environment: environmentData,
      idAnalyzer: idAnalyzerResult,
      status: idData.idNumber && !idAnalyzerResult.decision === 'accept' ? 'VERIFIED' : 'FAILED'
    };

    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(verificationReport, null, 2));
  } catch (error) {
    console.error('❌ General verification error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Face detection helper
async function detectFace(imageBuffer) {
  const result = await faceClient.path("/detect").post({
    body: imageBuffer,
    headers: {
      "Content-Type": "application/octet-stream"
    },
    queryParameters: {
      detectionModel: "detection_03",
      returnFaceId: true
    }
  });
  if (result.status !== 200) throw new Error("Face detection failed");
  return result.body[0]?.faceId;
}

// Face comparison helper
async function verifyFaces(faceId1, faceId2) {
  const result = await faceClient.path("/verify").post({
    body: { faceId1, faceId2 }
  });
  if (result.status !== 200) throw new Error("Face verification failed");
  return result.body.isIdentical;
}

// Start server
app.listen(port, () => {
  console.log(`✅ Server running on http://localhost:${port}`);
});
