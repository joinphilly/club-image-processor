const fetch = require('node-fetch');

async function processBatch(req, res) {
  try {
    const { clubs, config } = req.body;
    const results = [];
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    for (const club of clubs) {
      const clubResult = {
        clubName: club.name,
        rowIndex: club.rowIndex,
        processedImages: {
          hero: null,
          logo: null,
          gallery: []
        },
        status: 'processing'
      };

      try {
        // Process hero image
        if (club.heroUrl) {
          const response = await fetch(`${baseUrl}/api/process-images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageUrl: club.heroUrl,
              type: 'hero',
              clubName: club.name,
              config
            })
          });
          
          if (response.ok) {
            const data = await response.json();
            clubResult.processedImages.hero = data.result;
          }
        }

        // Process logo image
        if (club.logoUrl) {
          const response = await fetch(`${baseUrl}/api/process-images`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              imageUrl: club.logoUrl,
              type: 'logo',
              clubName: club.name,
              config
            })
          });
          
          if (response.ok) {
            const data = await response.json();
            clubResult.processedImages.logo = data.result;
          }
        }

        // Process gallery images
        if (club.galleryUrls && club.galleryUrls.length > 0) {
          for (let i = 0; i < Math.min(club.galleryUrls.length, 4); i++) {
            const response = await fetch(`${baseUrl}/api/process-images`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                imageUrl: club.galleryUrls[i],
                type: 'gallery',
                clubName: club.name,
                config,
                index: i
              })
            });
            
            if (response.ok) {
              const data = await response.json();
              clubResult.processedImages.gallery.push(data.result);
            }
          }
        }

        clubResult.status = 'completed';
      } catch (error) {
        clubResult.status = 'error';
        clubResult.error = error.message;
      }

      results.push(clubResult);
    }

    res.json({ success: true, results });

  } catch (error) {
    console.error('Batch processing error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = { processBatch };