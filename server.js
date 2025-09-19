// Updated server.js with Cloudinary integration
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs').promises;
const { v4: uuidv4 } = require('uuid');
const cloudinary = require('cloudinary').v2;

const app = express();
const upload = multer({ dest: 'uploads/' });

// Configure Cloudinary
if (process.env.CLOUDINARY_URL) {
    // Use the CLOUDINARY_URL environment variable (preferred method)
    cloudinary.config(process.env.CLOUDINARY_URL);
} else {
    // Fallback to individual environment variables
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
                // Escaped quote inside quoted field
                currentField += '"';
                i += 2;
                continue;
            } else {
                // Start or end of quoted field
                inQuotes = !inQuotes;
            }
        } else if (char === ',' && !inQuotes) {
            // Field separator
            currentRow.push(currentField);
            currentField = '';
        } else if ((char === '\n' || char === '\r') && !inQuotes) {
            // Row separator
            currentRow.push(currentField);
            if (currentRow.length > 0 && currentRow.some(field => field.trim() !== '')) {
                rows.push(currentRow);
            }
            currentRow = [];
            currentField = '';
            
            // Skip \r\n combination
            if (char === '\r' && nextChar === '\n') {
                i++;
            }
        } else {
            currentField += char;
        }
        
        i++;
    }
    
    // Don't forget the last field/row
    if (currentField !== '' || currentRow.length > 0) {
        currentRow.push(currentField);
        if (currentRow.length > 0 && currentRow.some(field => field.trim() !== '')) {
            rows.push(currentRow);
        }
    }
    
    if (rows.length < 1) return [];
    
    const headers = rows[0];
    console.log('CSV Headers found:', headers.length, 'columns');
    console.log('Column 28:', headers[27]); // Upload a hero image
    console.log('Column 29:', headers[28]); // Upload your community's logo  
    console.log('Column 30:', headers[29]); // Upload up to 4 images for your photo gallery
    
    const clubs = [];
    
    // Process data rows (skip header)
    for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
        const values = rows[rowIndex];
        
        if (values.length < 30) {
            console.log(`Row ${rowIndex} has only ${values.length} columns, skipping`);
            continue;
        }
        
        // Extract club name from the correct column
        const clubName = values[10]; // "What's the name of your club/community/group?"
        
        // Extract image URLs from the correct columns (0-indexed)
        const heroImage = values[27]; // "Upload a hero image::"
        const logoImage = values[28]; // "Upload your community's logo::"  
        const galleryImages = values[29]; // "Upload up to 4 images for your photo gallery::"
        
        console.log(`\nClub: ${clubName}`);
        console.log(`Hero: ${heroImage}`);
        console.log(`Logo: ${logoImage}`);
        console.log(`Gallery: ${galleryImages}`);
        
        if ((heroImage && isValidUrl(heroImage)) || 
            (logoImage && isValidUrl(logoImage)) || 
            (galleryImages && galleryImages.trim())) {
            
            const club = {
                name: cleanClubName(clubName || 'Unknown Club'),
                originalName: clubName, // Keep original for Airtable updates
                heroImage: (heroImage && isValidUrl(heroImage)) ? heroImage : null,
                logoImage: (logoImage && isValidUrl(logoImage)) ? logoImage : null,
                galleryImages: [],
                // Store other relevant data for Airtable updates
                submissionId: values[0], // For matching records
                email: values[8], // Club contact info
                rawData: values // Full row data for reference
            };
            
            // Process gallery images
            if (galleryImages && galleryImages.trim()) {
                const galleryUrls = galleryImages.split(',').map(url => url.trim()).filter(url => url && isValidUrl(url));
                club.galleryImages = galleryUrls;
            }
            
            clubs.push(club);
        }
    }
    
    return clubs;
}

// Helper function to validate URLs
function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (_) {
        return false;
    }
}

// Clean up club names for file naming
function cleanClubName(name) {
    return name
        .replace(/[^\w\s-]/g, '') // Remove special characters
        .replace(/\s+/g, '-') // Replace spaces with hyphens
        .toLowerCase()
        .substring(0, 50); // Limit length
}

// Process images endpoint
app.post('/api/process-images', upload.single('csvFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No CSV file uploaded' });
        }
        
        // Read and parse CSV
        const csvContent = await fs.readFile(req.file.path, 'utf-8');
        const clubs = parseCSV(csvContent);
        
        console.log(`Found ${clubs.length} clubs with images`);
        
        if (clubs.length === 0) {
            return res.status(400).json({ error: 'No clubs with images found in CSV' });
        }
        
        // Process each club's images
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
                cloudinaryUrls: [] // For downloads
            };
            
            // Process hero image
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
            
            // Process logo image
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
            
            // Process gallery images
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
        
        // Clean up uploaded file
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

// Image processing function using Sharp + Cloudinary
async function processImageToCloudinary(imageUrl, clubName, imageType, targetWidth) {
    try {
        console.log(`Processing ${imageType} for ${clubName}: ${imageUrl}`);
        
        // Check if Cloudinary is configured
        if (!process.env.CLOUDINARY_URL && (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)) {
            throw new Error('Cloudinary not configured. Please set CLOUDINARY_URL environment variable or individual CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET.');
        }
        
        // Download image
        const response = await fetch(imageUrl);
        if (!response.ok) {
            throw new Error(`Failed to download image: ${response.status}`);
        }
        
        const imageBuffer = await response.buffer();
        
        // Process image with Sharp
        const processedBuffer = await sharp(imageBuffer)
            .resize(targetWidth, null, { 
                withoutEnlargement: true,
                fit: 'inside'
            })
            .webp({ quality: 85 })
            .toBuffer();
        
        // Upload to Cloudinary
        const filename = `${clubName}-${imageType}`;
        
        return new Promise((resolve, reject) => {
            cloudinary.uploader.upload_stream(
                {
                    resource_type: 'image',
                    public_id: `joinphilly/${filename}`,
                    format: 'webp',
                    quality: 'auto:good',
                    tags: ['joinphilly', 'processed', imageType]
                },
                (error, result) => {
                    if (error) {
                        console.error('Cloudinary upload error:', error);
                        reject(new Error(`Cloudinary upload failed: ${error.message}`));
                    } else {
                        console.log('Cloudinary upload successful:', result.secure_url);
                        // Generate alt text in Brian's format
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

// Generate alt text in Brian's exact format
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

// Download processed images endpoint
app.post('/api/download-images', express.json(), async (req, res) => {
    try {
        const { results } = req.body;
        
        if (!results || !Array.isArray(results)) {
            return res.status(400).json({ error: 'No results provided for download' });
        }
        
        // Create a ZIP file with all processed images
        const JSZip = require('jszip');
        const zip = new JSZip();
        
        for (const club of results) {
            if (club.cloudinaryUrls && club.cloudinaryUrls.length > 0) {
                const clubFolder = zip.folder(club.cleanName);
                
                for (const processed of club.processed) {
                    try {
                        // Download from Cloudinary
                        const response = await fetch(processed.cloudinaryUrl);
                        const buffer = await response.buffer();
                        
                        clubFolder.file(processed.filename, buffer);
                    } catch (error) {
                        console.error(`Failed to download ${processed.filename}:`, error);
                    }
                }
            }
        }
        
        // Generate ZIP file
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
    console.log('Cloudinary config:', cloudinary.config());
});