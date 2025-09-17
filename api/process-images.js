const sharp = require('sharp');
const fetch = require('node-fetch');
const { v2: cloudinary } = require('cloudinary');

async function processImage(req, res) {
  try {
    const { imageUrl, type, clubName, config, index = 0 } = req.body;
    
    console.log(`Processing ${type} image for ${clubName}`);
    
    // Download the image
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`Failed to download image: ${response.statusText}`);
    }
    
    const buffer = await response.buffer();
    
    // Generate filename
    const slug = clubName
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim()
      .substring(0, 50);
    
    const filename = `${slug}-${type}${index ? `-${index}` : ''}.webp`;

    // Process image based on type
    let processedBuffer;
    
    switch (type) {
      case 'hero':
        processedBuffer = await sharp(buffer)
          .resize(config.heroMaxWidth || 1600, null, { 
            fit: 'inside', 
            withoutEnlargement: true 
          })
          .webp({ 
            quality: config.quality || 80,
            progressive: true 
          })
          .toBuffer();
        break;
        
      case 'logo':
        processedBuffer = await sharp(buffer)
          .resize(config.logoMaxWidth || 400, config.logoMaxWidth || 400, { 
            fit: 'inside', 
            withoutEnlargement: true 
          })
          .webp({ quality: config.quality || 90 })
          .toBuffer();
        break;
        
      case 'gallery':
        processedBuffer = await sharp(buffer)
          .resize(config.galleryMaxWidth || 1200, config.galleryMaxWidth || 1200, { 
            fit: 'inside', 
            withoutEnlargement: true 
          })
          .webp({ 
            quality: config.quality || 80,
            progressive: true 
          })
          .toBuffer();
        break;
        
      default:
        throw new Error(`Unknown image type: ${type}`);
    }

    // Upload to Cloudinary
    const uploadedUrl = await uploadToCloudinary(processedBuffer, filename);
    
    // Generate alt text
    const altText = generateAltText(type, clubName);
    
    // Get dimensions
    const metadata = await sharp(processedBuffer).metadata();
    
    res.json({
      success: true,
      result: {
        originalUrl: imageUrl,
        processedUrl: uploadedUrl,
        filename,
        altText,
        size: processedBuffer.length,
        dimensions: `${metadata.width}x${metadata.height}`,
        type
      }
    });

  } catch (error) {
    console.error('Image processing error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}

async function uploadToCloudinary(buffer, filename) {
  if (!process.env.CLOUDINARY_URL) {
    // Return mock URL for testing
    return `https://mock-cdn.com/${filename}`;
  }
  
  return new Promise((resolve, reject) => {
    cloudinary.uploader.upload_stream(
      {
        resource_type: 'image',
        public_id: filename.replace(/\.[^/.]+$/, ''),
        folder: 'processed-club-images',
        overwrite: true
      },
      (error, result) => {
        if (error) reject(error);
        else resolve(result.secure_url);
      }
    ).end(buffer);
  });
}

function generateAltText(type, clubName) {
  const altTexts = {
    hero: `${clubName} hero image`,
    logo: `${clubName} logo`,
    gallery: `${clubName} group photo`
  };
  
  return altTexts[type] || `${clubName} image`;
}

module.exports = { processImage };