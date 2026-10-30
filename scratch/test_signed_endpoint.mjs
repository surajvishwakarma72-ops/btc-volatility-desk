async function testEndpoints() {
  const urls = [
    'http://127.0.0.1:4000/api/v1/delta/signed?kind=read&path=/v2/positions/margined&query=contract_types%3Dcall_options%2Cput_options',
    'http://127.0.0.1:4000/api/v1/delta/signed?kind=trade&path=/v2/positions/margined&query=contract_types%3Dcall_options%2Cput_options',
    'http://127.0.0.1:4000/api/v1/delta/signed?kind=read&path=/v2/fills&query=contract_types%3Dcall_options%2Cput_options%26page_size%3D10',
    'http://127.0.0.1:4000/api/v1/delta/signed?kind=trade&path=/v2/fills&query=contract_types%3Dcall_options%2Cput_options%26page_size%3D10'
  ];

  for (const u of urls) {
    try {
      const res = await fetch(u);
      console.log('URL:', u);
      console.log('Status:', res.status);
      const text = await res.text();
      console.log('Response (first 300 chars):', text.slice(0, 300));
      console.log('---');
    } catch (err) {
      console.error('Error fetching', u, err.message);
    }
  }
}
testEndpoints();

