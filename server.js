// Complete server.js with webhook endpoint for n8n integration
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;
const cloudinary = require('cloudinary').v2;
const JSZip = require('jszip');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Configure Cloudinary
if (process.env.CLOUDINARY_URL) {
    const cloudinaryUrl = process.env.CLOUDINARY_URL;
    const urlParts = cloudinaryUrl.match(/cloudinary:\/\/(\d+):([^@]+)@(.+)/);
    
    if (urlParts) {
        cloudinary.config({
            cloud_name: urlParts[3],
            api_key: urlParts[1],
            api_secret: urlParts[2]
        });
    } else {
        cloudinary.config(process.env.CLOUDINARY_URL);
    }
} else {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

// Serve static files
app.use(express.static('public'));
app.use(express.json());

// Parse CSV with proper RFC 4180 compliant parsing
function parseCSV(csvText) {
    const rows = [];
    let currentRow = [];
    let currentField = '';
    let inQuotes = false;
    let i = 0;
    
    while (i < csvText.length) {
        const char = csvText[i];
        const nextChar = csvText[i + 1];
        
        if (char === '"') {
            if (inQuotes && nextChar === '"') {
                currentField += '"';
                i += 2;
                continue;
            } else {
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            currentRow.push(currentField);
            currentField = '';
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            currentRow.push(currentField);
            if (currentRow.length > 0 && currentRow.some(field => field.trim() !== '')) {
                rows.push(currentRow);
            }
            currentRow = [];
            currentField = '';
            
            if (char === '\r' && nextChar === '\n') {
                i++;
            }
        } else {
            currentField += char;
        }
        
        i++;
    }
    
    if (currentField !== '' || currentRow.length > 0) {
        currentRow.push(currentField);
        if (currentRow.length > 0 && currentRow.some(field => field.trim() !== '')) {
            rows.push(currentRow);
        }
    }
    
    if (rows.length < 1) return [];
    
    const headers = rows[0];
    console.log('CSV Headers found:', headers.length, 'columns');
    
    const clubs = [];
    
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
        const values = rows[rowIndex];
        
        if (values.length < 30) {
            console.log(`Row ${rowIndex} has only ${values.length} columns, skipping`);
            continue;
        }
        
        const clubName = values[10];
        const heroImage = values[27];
        const logoImage = values[28];
        const galleryImages = values[29];
        
        if ((heroImage && isValidUrl(heroImage)) || 
            (logoImage && isValidUrl(logoImage)) || 
            (galleryImages && galleryImages.trim())) {
            
            const club = {
                name: cleanClubName(clubName || 'Unknown Club'),
                originalName: clubName,
                heroImage: (heroImage && isValidUrl(heroImage)) ? heroImage : null,
                logoImage: (logoImage && isValidUrl(logoImage)) ? logoImage : null,
                galleryImages: [],
                submissionId: values[0],
                email: values[8],
                rawData: values
            };
            
            if (galleryImages && galleryImages.trim()) {
                const galleryUrls = galleryImages.split(',').map(url => url.trim()).filter(url => url && isValidUrl(url));
                club.galleryImages = galleryUrls;
            }
            
            clubs.push(club);
        }
    }
    
    return clubs;
}

function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

function cleanClubName(name) {
    return name
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .toLowerCase()
        .substring(0, 50);
}

// EXISTING CSV UPLOAD ENDPOINT - unchanged, keeps working
app.post('/api/process-images', upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No CSV file uploaded' });
        }
        
        const csvContent = await fs.readFile(req.file.path, 'utf-8');
        const clubs = parseCSV(csvContent);
        
        console.log(`Found ${clubs.length} clubs with images`);
        
        if (clubs.length === 0) {
            return res.status(400).json({ error: 'No clubs with images found in CSV' });
        }
        
        const results = [];
        
        for (const club of clubs) {
            console.log(`Processing club: ${club.name}`);
            const clubResult = {
                name: club.originalName,
                cleanName: club.name,
                submissionId: club.submissionId,
                email: club.email,
                processed: [],
                errors: [],
                cloudinaryUrls: [],
                airtableUpdate: null
            };
            
            if (club.heroImage) {
                try {
                    const processed = await processImageToCloudinary(club.heroImage, club.name, 'hero', 1600);
                    clubResult.processed.push(processed);
                    clubResult.cloudinaryUrls.push(processed.cloudinaryUrl);
                } catch (error) {
                    console.error(`Hero image error for ${club.name}:`, error.message);
                    clubResult.errors.push(`Hero image: ${error.message}`);
                }
            }
            
            if (club.logoImage) {
                try {
                    const processed = await processImageToCloudinary(club.logoImage, club.name, 'logo', 400);
                    clubResult.processed.push(processed);
                    clubResult.cloudinaryUrls.push(processed.cloudinaryUrl);
                } catch (error) {
                    console.error(`Logo image error for ${club.name}:`, error.message);
                    clubResult.errors.push(`Logo image: ${error.message}`);
                }
            }
            
            for (let i = 0; i < club.galleryImages.length && i < 4; i++) {
                const galleryUrl = club.galleryImages[i];
                if (galleryUrl) {
                    try {
                        const processed = await processImageToCloudinary(galleryUrl, club.name, `gallery-${i+1}`, 1200);
                        clubResult.processed.push(processed);
                        clubResult.cloudinaryUrls.push(processed.cloudinaryUrl);
                    } catch (error) {
                        console.error(`Gallery image ${i+1} error for ${club.name}:`, error.message);
                        clubResult.errors.push(`Gallery image ${i+1}: ${error.message}`);
                    }
                }
            }
            
            results.push(clubResult);
        }
        
        if (process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_TABLE_NAME && process.env.AIRTABLE_TOKEN) {
            console.log('Attempting to update Airtable records...');
            for (const result of results) {
                if (result.processed.length > 0) {
                    try {
                        const airtableUpdate = await updateAirtableRecord(result);
                        result.airtableUpdate = airtableUpdate;
                    } catch (error) {
                        console.error(`Failed to update Airtable for ${result.name}:`, error.message);
                        result.errors.push(`Airtable update failed: ${error.message}`);
                    }
                }
            }
        }
        
        await fs.unlink(req.file.path);
        
        res.json({
            success: true,
            clubsProcessed: results.length,
            results: results
        });
        
    } catch (error) {
        console.error('Processing error:', error);
        res.status(500).json({ error: error.message });
    }
});

// NEW: Webhook endpoint for n8n integration - handles cleaned data from n8n Code node
app.post('/api/process-webhook', async (req, res) => {
    try {
        console.log('Received webhook data from n8n:', JSON.stringify(req.body, null, 2));
        
        // Data comes cleaned from n8n Code node
        const clubData = req.body;
        
        // Validate we have required data
        if (!clubData.clubName) {
            return res.status(400).json({ 
                error: 'Missing required field: clubName',
                receivedData: clubData 
            });
        }
        
        // Validate that we have at least one image
        if (!clubData.heroImageUrl && !clubData.logoImageUrl && !clubData.galleryImageUrls) {
            return res.status(400).json({ 
                error: 'No images found in submission',
                receivedData: clubData 
            });
        }
        
        console.log('Processing club:', clubData.clubName);
        
        // Create result object
        const clubResult = {
            name: clubData.clubName,
            cleanName: cleanClubName(clubData.clubName),
            submissionId: clubData.submissionId || '',
            email: clubData.email || '',
            processed: [],
            errors: [],
            cloudinaryUrls: [],
            airtableUpdate: null
        };
        
        // Process hero image
        if (clubData.heroImageUrl && isValidUrl(clubData.heroImageUrl)) {
            try {
                console.log('Processing hero image:', clubData.heroImageUrl);
                const processed = await processImageToCloudinary(
                    clubData.heroImageUrl, 
                    clubResult.cleanName, 
                    'hero', 
                    1600
                );
                clubResult.processed.push(processed);
                clubResult.cloudinaryUrls.push(processed.cloudinaryUrl);
            } catch (error) {
                console.error(`Hero image error: ${error.message}`);
                clubResult.errors.push(`Hero image: ${error.message}`);
            }
        }
        
        // Process logo image
        if (clubData.logoImageUrl && isValidUrl(clubData.logoImageUrl)) {
            try {
                console.log('Processing logo image:', clubData.logoImageUrl);
                const processed = await processImageToCloudinary(
                    clubData.logoImageUrl, 
                    clubResult.cleanName, 
                    'logo', 
                    400
                );
                clubResult.processed.push(processed);
                clubResult.cloudinaryUrls.push(processed.cloudinaryUrl);
            } catch (error) {
                console.error(`Logo image error: ${error.message}`);
                clubResult.errors.push(`Logo image: ${error.message}`);
            }
        }
        
        // Process gallery images
        if (clubData.galleryImageUrls) {
            let galleryUrls = [];
            
            // Handle if it's already an array or if it's a comma-separated string
            if (Array.isArray(clubData.galleryImageUrls)) {
                galleryUrls = clubData.galleryImageUrls;
            } else if (typeof clubData.galleryImageUrls === 'string') {
                galleryUrls = clubData.galleryImageUrls
                    .split(',')
                    .map(url => url.trim())
                    .filter(url => url && isValidUrl(url));
            }
            
            for (let i = 0; i < galleryUrls.length && i < 4; i++) {
                if (galleryUrls[i] && isValidUrl(galleryUrls[i])) {
                    try {
                        console.log(`Processing gallery image ${i+1}:`, galleryUrls[i]);
                        const processed = await processImageToCloudinary(
                            galleryUrls[i], 
                            clubResult.cleanName, 
                            `gallery-${i+1}`, 
                            1200
                        );
                        clubResult.processed.push(processed);
                        clubResult.cloudinaryUrls.push(processed.cloudinaryUrl);
                    } catch (error) {
                        console.error(`Gallery image ${i+1} error: ${error.message}`);
                        clubResult.errors.push(`Gallery image ${i+1}: ${error.message}`);
                    }
                }
            }
        }
        
        // Update Airtable if configured
        if (process.env.AIRTABLE_BASE_ID && process.env.AIRTABLE_TABLE_NAME && process.env.AIRTABLE_TOKEN) {
            if (clubResult.processed.length > 0) {
                try {
                    console.log('Updating Airtable record...');
                    const airtableUpdate = await updateAirtableRecord(clubResult);
                    clubResult.airtableUpdate = airtableUpdate;
                } catch (error) {
                    console.error(`Airtable update failed: ${error.message}`);
                    clubResult.errors.push(`Airtable update failed: ${error.message}`);
                }
            }
        }
        
        console.log('Webhook processing complete:', {
            clubName: clubResult.name,
            imagesProcessed: clubResult.processed.length,
            errors: clubResult.errors.length
        });
        
        res.json({
            success: true,
            message: 'Images processed successfully via webhook',
            clubName: clubResult.name,
            imagesProcessed: clubResult.processed.length,
            processedImages: clubResult.processed.map(p => ({
                type: p.type,
                url: p.cloudinaryUrl,
                altText: p.altText
            })),
            errors: clubResult.errors,
            airtableUpdated: clubResult.airtableUpdate ? clubResult.airtableUpdate.success : false
        });
        
    } catch (error) {
        console.error('Webhook processing error:', error);
        res.status(500).json({ 
            error: error.message,
            receivedData: req.body 
        });
    }
});

// Image processing function using Sharp + Cloudinary
async function processImageToCloudinary(imageUrl, clubName, imageType, targetWidth) {
    try {
        console.log(`Processing ${imageType} for ${clubName}: ${imageUrl}`);
        
        if (!process.env.CLOUDINARY_URL && (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)) {
            throw new Error('Cloudinary not configured');
        }
        
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to download image: ${response.status}`);
        }
        
        const imageBuffer = await response.buffer();
        
        const processedBuffer = await sharp(imageBuffer)
            .resize(targetWidth, null, { 
                withoutEnlargement: true,
                fit: 'inside'
            })
            .webp({ quality: 85 })
            .toBuffer();
        
        const filename = `${clubName}-${imageType}`;
        
        return new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
                {
                    resource_type: 'image',
                    public_id: `joinphilly/${filename}`,
                    format: 'webp',
                    tags: ['joinphilly', 'processed', imageType]
                },
                (error, result) => {
                    if (error) {
                        console.error('Cloudinary upload error:', error);
                        reject(new Error(`Cloudinary upload failed: ${error.message}`));
                    } else {
                        console.log('Cloudinary upload successful:', result.secure_url);
                        const altText = generateAltText(clubName, imageType);
                        
                        resolve({
                            originalUrl: imageUrl,
                            cloudinaryUrl: result.secure_url,
                            publicId: result.public_id,
                            filename: `${filename}.webp`,
                            altText: altText,
                            width: result.width,
                            height: result.height,
                            type: imageType,
                            format: 'webp'
                        });
                    }
                }
            ).end(processedBuffer);
        });
        
    } catch (error) {
        console.error(`Image processing failed for ${imageUrl}:`, error);
        throw error;
    }
}

function generateAltText(clubName, imageType) {
    const properClubName = clubName.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    switch (imageType) {
        case 'hero':
            return `${properClubName} hero image`;
        case 'logo':
            return `${properClubName} logo`;
        case 'gallery-1':
        case 'gallery-2':
        case 'gallery-3':
        case 'gallery-4':
            return `${properClubName} group photo`;
        default:
            return `${properClubName} image`;
    }
}

async function updateAirtableRecord(clubResult) {
    try {
        const baseId = process.env.AIRTABLE_BASE_ID;
        const tableName = process.env.AIRTABLE_TABLE_NAME;
        const token = process.env.AIRTABLE_TOKEN;
        
        const searchUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}`;
        
        let searchResponse;
        let searchData;
        
        if (clubResult.submissionId && clubResult.submissionId.trim()) {
            const submissionIdFilter = `{Submission ID} = "${clubResult.submissionId.replace(/"/g, '\\"')}"`;
            console.log('Trying Submission ID search:', submissionIdFilter);
            
            searchResponse = await fetch(`${searchUrl}?filterByFormula=${encodeURIComponent(submissionIdFilter)}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (searchResponse.ok) {
                searchData = await searchResponse.json();
                if (searchData.records.length > 0) {
                    console.log('Found record by Submission ID');
                }
            }
        }
        
        if (!searchData || searchData.records.length === 0) {
            if (clubResult.name && clubResult.name.trim()) {
                const names = [clubResult.name, clubResult.cleanName].filter(n => n && n.trim());
                
                for (const nameToTry of names) {
                    const nameFilter = `{Name} = "${nameToTry.replace(/"/g, '\\"')}"`;
                    console.log('Trying Name search:', nameFilter);
                    
                    searchResponse = await fetch(`${searchUrl}?filterByFormula=${encodeURIComponent(nameFilter)}`, {
                        headers: {
                            'Authorization': `Bearer ${token}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    
                    if (searchResponse.ok) {
                        searchData = await searchResponse.json();
                        if (searchData.records.length > 0) {
                            console.log(`Found record by Name: "${nameToTry}"`);
                            break;
                        }
                    }
                }
            }
        }
        
        if (!searchResponse.ok) {
            const errorData = await searchResponse.json().catch(() => ({ error: 'Unknown error' }));
            throw new Error(`Airtable search failed: ${searchResponse.status}`);
        }
        
        if (!searchData || searchData.records.length === 0) {
            throw new Error(`No matching Airtable record found for "${clubResult.name}"`);
        }
        
        const recordId = searchData.records[0].id;
        console.log(`Found Airtable record ${recordId} for ${clubResult.name}`);
        
        const updateFields = {};
        const galleryUrls = [];
        
        for (const processed of clubResult.processed) {
            switch (processed.type) {
                case 'hero':
                    updateFields['Hero URL'] = processed.cloudinaryUrl;
                    updateFields['Hero Alt Text'] = processed.altText;
                    break;
                case 'logo':
                    updateFields['Logo URL'] = processed.cloudinaryUrl;
                    updateFields['Logo Alt Text'] = processed.altText;
                    break;
                case 'gallery-1':
                    updateFields['Gallery 1 Alt Text'] = processed.altText;
                    galleryUrls[0] = processed.cloudinaryUrl;
                    break;
                case 'gallery-2':
                    updateFields['Gallery 2 Alt Text'] = processed.altText;
                    galleryUrls[1] = processed.cloudinaryUrl;
                    break;
                case 'gallery-3':
                    updateFields['Gallery 3 Alt Text'] = processed.altText;
                    galleryUrls[2] = processed.cloudinaryUrl;
                    break;
                case 'gallery-4':
                    updateFields['Gallery 4 Alt Text'] = processed.altText;
                    galleryUrls[3] = processed.cloudinaryUrl;
                    break;
            }
        }
        
        if (galleryUrls.length > 0) {
            updateFields['Photo Gallery Url'] = galleryUrls.filter(url => url).map(url => ({
                url: url
            }));
        }
        
        const updateUrl = `${searchUrl}/${recordId}`;
        const updateResponse = await fetch(updateUrl, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fields: updateFields
            })
        });
        
        if (!updateResponse.ok) {
            const errorData = await updateResponse.json();
            throw new Error(`Airtable update failed: ${errorData.error?.message || updateResponse.status}`);
        }
        
        const updateData = await updateResponse.json();
        console.log(`Successfully updated Airtable record for ${clubResult.name}`);
        
        return {
            success: true,
            recordId: recordId,
            fieldsUpdated: Object.keys(updateFields).length,
            message: `Updated ${Object.keys(updateFields).length} fields in Airtable`
        };
        
    } catch (error) {
        console.error('Airtable update error:', error);
        throw error;
    }
}

// Test endpoints
app.get('/api/test-airtable', async (req, res) => {
    try {
        const baseId = process.env.AIRTABLE_BASE_ID;
        const tableName = process.env.AIRTABLE_TABLE_NAME;
        const token = process.env.AIRTABLE_TOKEN;
        
        if (!baseId || !tableName || !token) {
            return res.json({
                error: 'Airtable not configured',
                config: {
                    base_id: baseId ? 'set' : 'missing',
                    table_name: tableName ? 'set' : 'missing',
                    token: token ? 'set' : 'missing'
                }
            });
        }
        
        const testUrl = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?maxRecords=3`;
        
        const response = await fetch(testUrl, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            const errorText = await response.text();
            return res.json({
                error: 'Airtable API failed',
                status: response.status,
                message: errorText
            });
        }
        
        const data = await response.json();
        const availableFields = data.records.length > 0 ? Object.keys(data.records[0].fields) : [];
        
        res.json({
            success: true,
            message: 'Airtable connection working',
            recordCount: data.records.length,
            availableFields: availableFields,
            sampleRecord: data.records[0] ? {
                id: data.records[0].id,
                firstFewFields: Object.fromEntries(
                    Object.entries(data.records[0].fields).slice(0, 5)
                )
            } : null
        });
        
    } catch (error) {
        res.json({
            error: 'Airtable test failed',
            message: error.message
        });
    }
});

app.get('/api/test-cloudinary', async (req, res) => {
    try {
        const config = cloudinary.config();
        
        if (!config.cloud_name || !config.api_key || !config.api_secret) {
            return res.json({
                error: 'Cloudinary not properly configured',
                config: {
                    cloud_name: config.cloud_name || 'missing',
                    api_key: config.api_key ? 'set' : 'missing',
                    api_secret: config.api_secret ? 'set' : 'missing'
                }
            });
        }
        
        const testImage = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
        
        const result = await new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
                {
                    resource_type: 'image',
                    public_id: 'test-upload-' + Date.now()
                },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            ).end(testImage);
        });
        
        await cloudinary.uploader.destroy(result.public_id);
        
        res.json({
            success: true,
            message: 'Cloudinary configuration is working',
            test_result: {
                public_id: result.public_id,
                secure_url: result.secure_url
            }
        });
        
    } catch (error) {
        console.error('Cloudinary test error:', error);
        res.json({
            error: 'Cloudinary test failed',
            message: error.message
        });
    }
});

app.post('/api/download-images', express.json(), async (req, res) => {
    try {
        const { results } = req.body;
        
        if (!results || !Array.isArray(results)) {
            return res.status(400).json({ error: 'No results provided for download' });
        }
        
        const zip = new JSZip();
        
        for (const club of results) {
            if (club.cloudinaryUrls && club.cloudinaryUrls.length > 0) {
                const clubFolder = zip.folder(club.cleanName);
                
                for (const processed of club.processed) {
                    try {
                        const response = await fetch(processed.cloudinaryUrl);
                        const buffer = await response.buffer();
                        clubFolder.file(processed.filename, buffer);
                    } catch (error) {
                        console.error(`Failed to download ${processed.filename}:`, error);
                    }
                }
            }
        }
        
        const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="processed-images.zip"');
        res.send(zipBuffer);
        
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Failed to create download package' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log('Environment check:');
    console.log('CLOUDINARY_URL:', process.env.CLOUDINARY_URL ? 'Set' : 'Missing');
    
    const config = cloudinary.config();
    console.log('Cloudinary cloud_name:', config.cloud_name);
    console.log('Cloudinary api_key:', config.api_key ? config.api_key.substring(0, 6) + '...' : 'Missing');
    console.log('Cloudinary api_secret:', config.api_secret ? '***set***' : 'Missing');
    
    console.log('Airtable BASE_ID:', process.env.AIRTABLE_BASE_ID ? 'Set' : 'Missing');
    console.log('Airtable TABLE_NAME:', process.env.AIRTABLE_TABLE_NAME ? 'Set' : 'Missing');
    console.log('Airtable TOKEN:', process.env.AIRTABLE_TOKEN ? 'Set' : 'Missing');
});