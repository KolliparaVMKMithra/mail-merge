const url = 'http://localhost:3000';

async function runTests() {
  console.log('--- STARTING CAMPAIGN-FILTERED BOUNCE REPOSITORY API TESTS ---');

  // 1. Login to retrieve session token
  console.log('1. Logging in...');
  const loginRes = await fetch(`${url}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'b_sreekrishna@av.amrita.edu', password: 'krishna@123' })
  });

  const loginCookie = loginRes.headers.get('set-cookie');
  if (!loginCookie) {
    throw new Error('Failed to get session cookie from login response');
  }

  const sessionTokenCookie = loginCookie.split(';')[0];
  console.log('Login successful. Cookie:', sessionTokenCookie);

  // Helper to make authenticated requests
  async function authFetch(path, options = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'Cookie': sessionTokenCookie,
      ...(options.headers || {})
    };
    return fetch(`${url}${path}`, { ...options, headers });
  }

  // 2. Fetch current bounces
  console.log('\n2. Fetching current bounces repository...');
  const bouncesRes = await authFetch('/api/bounces');
  const bouncesData = await bouncesRes.json();
  console.log(`Current bounces count: ${bouncesData.bounces.length}`);

  // 3. Clear repository to start from a clean state
  console.log('\n3. Clearing repository...');
  const clearRes = await authFetch('/api/clear-bounces', { method: 'POST' });
  const clearData = await clearRes.json();
  if (clearData.success) {
    console.log('Repository cleared successfully.');
  } else {
    throw new Error('Failed to clear repository');
  }

  // Verify it is empty
  const bouncesRes2 = await authFetch('/api/bounces');
  const bouncesData2 = await bouncesRes2.json();
  console.log(`Bounces count after clearing: ${bouncesData2.bounces.length}`);
  if (bouncesData2.bounces.length !== 0) {
    throw new Error('Repository should be empty after clear-bounces');
  }

  // 4. Trigger check-bounces with NO contacts (should NOT trigger scan, count should stay 0)
  console.log('\n4. Running check-bounces scan with empty contacts list...');
  const checkEmptyRes = await authFetch('/api/check-bounces', {
    method: 'POST',
    body: JSON.stringify({ contacts: [], campaignStartTime: new Date().toISOString() })
  });
  const checkEmptyData = await checkEmptyRes.json();
  console.log(`Repository bounces count (empty scan): ${checkEmptyData.bounces.length}`);
  if (checkEmptyData.bounces.length !== 0) {
    throw new Error('Repository should not accumulate new bounces when scanned with an empty contacts list');
  }

  // 5. Trigger check-bounces WITH contacts (active campaign filtering test)
  console.log('\n5. Running check-bounces scan with active campaign contacts list...');
  const contacts = ["test.recipient1@amrita.edu", "test.recipient2@amrita.edu", "test.recipient3@amrita.edu"];
  const campaignStartTime = new Date();
  
  const checkRes = await authFetch('/api/check-bounces', {
    method: 'POST',
    body: JSON.stringify({ contacts, campaignStartTime: campaignStartTime.toISOString() })
  });
  const checkData = await checkRes.json();
  console.log(`Scan complete. Configured: ${checkData.configured}. Scanned: ${checkData.totalScanned}. Bounces in repository now: ${checkData.bounces.length}`);

  if (checkData.configured) {
    console.log('Active mode is configured. As expected, scanning the real inbox with dummy recipient emails resulted in 0 matches.');
    console.log('Skipping single delete tests because repository is empty.');
  } else {
    if (checkData.bounces.length === 0) {
      throw new Error('No mock bounces added to repository after scanning with active contacts list in mock mode');
    }

    // Verify the added mock bounces match the contacts
    const addedBounces = checkData.bounces;
    console.log('Bounces in repository after mock scan:');
    addedBounces.forEach(b => {
      console.log(` - ID: ${b.id}, Email: ${b.bouncedEmail}, Time: ${b.receivedTime}`);
    });

    const allMatchContacts = addedBounces.every(b => contacts.includes(b.bouncedEmail));
    if (!allMatchContacts) {
      throw new Error('One or more bounces in repository do not match the campaign contacts list!');
    }
    console.log('Verification: All mock bounces in repository strictly match the active campaign contact list.');

    // 6. Delete a single bounce record
    const firstBounce = addedBounces[0];
    console.log(`\n6. Deleting single bounce: ID=${firstBounce.id}...`);
    const deleteRes = await authFetch('/api/delete-bounce', {
      method: 'POST',
      body: JSON.stringify({ id: firstBounce.id })
    });
    const deleteData = await deleteRes.json();
    if (deleteData.success) {
      console.log('Single bounce deleted successfully.');
    } else {
      throw new Error('Failed to delete single bounce');
    }

    // Verify count decreases by 1
    const bouncesRes3 = await authFetch('/api/bounces');
    const bouncesData3 = await bouncesRes3.json();
    console.log(`Bounces count after single delete: ${bouncesData3.bounces.length}`);
    const deletedStillExists = bouncesData3.bounces.some(b => b.id === firstBounce.id);
    if (deletedStillExists) {
      throw new Error('Deleted bounce still exists in repository!');
    }
    console.log('Verification: Deleted bounce was successfully removed.');
  }

  console.log('\n--- ALL TESTS PASSED SUCCESSFULLY! ---');
}

runTests().catch(err => {
  console.error('\n!!! TEST FAILED !!!');
  console.error(err);
  process.exit(1);
});
