/**
 * 早餐點餐工具 - 後端腳本 (GAS)
 * 請將此程式碼貼到 Google 試算表的「擴充功能」 > 「Apps Script」中。
 * 部署時請選擇「網頁應用程式」，並設定「誰可以用有權存取」為「任何人」。
 */

function doGet(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const shopSheet = ss.getSheetByName('早餐店');
  const priceSheet = ss.getSheetByName('價格');
  
  // 取得店家清單
  const shops = shopSheet.getRange(1, 1, shopSheet.getLastRow(), 1).getValues().flat();
  
  // 取得價格清單
  const priceData = priceSheet.getDataRange().getValues();
  const menu = [];
  // 假設標題為：早餐店	餐點	價格
  for (let i = 1; i < priceData.length; i++) {
    menu.push({
      shop: priceData[i][0],
      item: priceData[i][1],
      price: priceData[i][2]
    });
  }
  
  // 取得紀錄 (顯示最後 20 筆)
  // 欄位結構：取餐日期, 取餐時間, 餐點, 總金額
  const recordSheet = ss.getSheetByName('紀錄');
  const recordData = recordSheet.getDataRange().getValues();
  const records = [];
  
  for (let i = Math.max(1, recordData.length - 20); i < recordData.length; i++) {
    records.push({
      pickupDate: recordData[i][0],
      pickupTime: recordData[i][1],
      items: recordData[i][2],
      total: recordData[i][3]
    });
  }
  
  const result = {
    shops: shops.filter(s => s !== ""),
    menu: menu,
    records: records.reverse() // 最新紀錄排前面
  };
  
  return ContentService.createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const params = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const recordSheet = ss.getSheetByName('紀錄');
    
    // params 格式：{ pickupDate, pickupTime, items, total }
    recordSheet.appendRow([
      params.pickupDate,
      params.pickupTime,
      params.items,
      params.total
    ]);
    
    return ContentService.createTextOutput(JSON.stringify({ status: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ status: 'error', message: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
