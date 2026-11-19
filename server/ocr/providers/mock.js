'use strict';
// Demo provider: ignores the image and returns sample form text, so the full
// scan -> review -> confirm flow can be exercised before a real model is mounted.

const SAMPLES = [
  `IRBY DENTAL CLINIC - PATIENT REGISTRATION FORM
Last Name: DELA CRUZ    First Name: Mateo    Middle Name: Lorenzo
Date of Birth: 04/12/1992        Sex: [x] Male [ ] Female
Address: Unit 14B, Salcedo Village, Makati City, Metro Manila
Contact No: +63 917 550 0192
Allergies: Penicillin
Date: ${new Date().toISOString().slice(0, 10)}`,
  `PATIENT INFORMATION
Name: Santos, Clara Villanueva
Birthdate: March 3, 1997
Gender: Female
Home Address: 22 Mabini St., Brgy. San Antonio, Pasig City
Mobile Number: 0918 221 8840
Allergies: None`,
  `Surname: Reyes  Given Name: Antonio  M.I.: G.
DOB: 1980-07-21   Sex: M
Address: Blk 5 Lot 9, Camella Homes, Bacoor, Cavite
Contact: 0998-412-3309
Medical Alerts: Latex allergy; hypertension`,
];

module.exports = (opts) => {
  let i = 0;
  return {
    description: 'Built-in demo data (no model mounted)',
    status: async () => ({ ready: true, demo: true, detail: 'Returns sample registration data. Set OCR_PROVIDER to mount a real model.' }),
    recognize: async () => {
      await new Promise((r) => setTimeout(r, opts.mockDelayMs));
      const text = SAMPLES[i++ % SAMPLES.length];
      return { text, confidence: 0.9 };
    },
  };
};
