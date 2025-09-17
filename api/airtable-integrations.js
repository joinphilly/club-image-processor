const Airtable = require('airtable');

async function readFromAirtable(req, res) {
  try {
    const { apiKey, baseId, tableName } = req.body;
    
    const base = new Airtable({ apiKey }).base(baseId);
    const records = [];
    
    await base(tableName).select({}).eachPage((pageRecords, fetchNextPage) => {
      pageRecords.forEach(record => {
        const galleryString = record.fields["Upload up to 4 images for your photo gallery:"] || '';
        const galleryUrls = galleryString 
          ? galleryString.split(',').map(url => url.trim()).filter(Boolean) 
          : [];

        records.push({
          name: record.fields["What's the name of your club/community/group?"] || '',
          heroUrl: record.fields["Upload a hero image:"] || '',
          logoUrl: record.fields["Upload your community's logo:"] || '',
          galleryUrls: galleryUrls,
          airtableId: record.id,
          originalFields: record.fields
        });
      });
      fetchNextPage();
    });

    res.json({ success: true, records });
  } catch (error) {
    console.error('Airtable read error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

async function writeToAirtable(req, res) {
  try {
    const { apiKey, baseId, tableName, updates } = req.body;
    
    const base = new Airtable({ apiKey }).base(baseId);
    const results = [];

    for (const update of updates) {
      try {
        const updateFields = {};
        
        if (update.processedImages.hero) {
          updateFields['Hero Image Processed URL'] = update.processedImages.hero.processedUrl;
          updateFields['Hero Image Alt Text'] = update.processedImages.hero.altText;
        }
        
        if (update.processedImages.logo) {
          updateFields['Logo Image Processed URL'] = update.processedImages.logo.processedUrl;
          updateFields['Logo Image Alt Text'] = update.processedImages.logo.altText;
        }
        
        if (update.processedImages.gallery.length > 0) {
          update.processedImages.gallery.forEach((img, index) => {
            updateFields[`Gallery Image ${index + 1} Processed URL`] = img.processedUrl;
            updateFields[`Gallery Image ${index + 1} Alt Text`] = img.altText;
          });
        }

        const updatedRecord = await base(tableName).update(update.airtableId, updateFields);
        results.push({ success: true, recordId: updatedRecord.id });
      } catch (error) {
        results.push({ success: false, error: error.message, recordId: update.airtableId });
      }
    }

    res.json({ success: true, results });
  } catch (error) {
    console.error('Airtable write error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
}

module.exports = { readFromAirtable, writeToAirtable };