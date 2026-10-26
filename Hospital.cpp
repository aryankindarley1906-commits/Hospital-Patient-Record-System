#include <iostream>
#include <fstream>
#include <sstream>
#include <string>
#include <iomanip>
#include <limits>
#include <utility>

using namespace std;

const int MAX = 100;
const string DATA_FILE = "patients_cpp.txt";

// Parallel arrays: values at the same index belong to one patient.
int patientID[MAX], patientAge[MAX];
string patientName[MAX], patientDisease[MAX], patientContact[MAX];
int count = 0;

bool containsDelimiter(const string& value) {
    return value.find('|') != string::npos || value.find('\r') != string::npos ||
           value.find('\n') != string::npos;
}

bool validContact(const string& contact) {
    if (contact.length() < 7 || contact.length() > 20) return false;
    for (char ch : contact) {
        if (!(ch >= '0' && ch <= '9') && ch != '+' && ch != '(' &&
            ch != ')' && ch != ' ' && ch != '.' && ch != '-') {
            return false;
        }
    }
    return true;
}

int readInt(const string& prompt, int minimum, int maximum) {
    while (true) {
        cout << prompt;
        string line;
        getline(cin >> ws, line);
        stringstream input(line);
        int value;
        char extra;
        if ((input >> value) && !(input >> extra) && value >= minimum && value <= maximum) {
            return value;
        }
        cout << "Enter a whole number from " << minimum << " to " << maximum << ".\n";
    }
}

string readText(const string& prompt, int maximumLength) {
    while (true) {
        cout << prompt;
        string value;
        getline(cin >> ws, value);
        if (value.empty()) {
            cout << "This field cannot be empty.\n";
        } else if (static_cast<int>(value.length()) > maximumLength) {
            cout << "Please use " << maximumLength << " characters or fewer.\n";
        } else if (containsDelimiter(value)) {
            cout << "The character '|' is reserved for file storage. Please enter the value again.\n";
        } else {
            return value;
        }
    }
}

string readContact() {
    while (true) {
        string contact = readText("Enter contact number: ", 20);
        if (validContact(contact)) return contact;
        cout << "Enter 7-20 digits or common phone-number symbols (+, -, spaces, parentheses, dot).\n";
    }
}

int findPatientIndex(int searchID) {
    // Linear search: check each ID until a match is found.
    for (int i = 0; i < count; i++) {
        if (patientID[i] == searchID) return i;
    }
    return -1;
}

bool saveRecords() {
    ofstream file(DATA_FILE, ios::trunc);
    if (!file) return false;

    for (int i = 0; i < count; i++) {
        // Fields containing '|' are rejected, so each line is safely split on '|'.
        file << patientID[i] << '|' << patientName[i] << '|' << patientAge[i]
             << '|' << patientDisease[i] << '|' << patientContact[i] << '\n';
    }
    return file.good();
}

void loadRecords() {
    ifstream file(DATA_FILE);
    string line;

    while (getline(file, line) && count < MAX) {
        string idText, name, ageText, disease, contact;
        stringstream row(line);
        if (!getline(row, idText, '|') || !getline(row, name, '|') ||
            !getline(row, ageText, '|') || !getline(row, disease, '|') ||
            !getline(row, contact)) {
            continue;
        }

        try {
            int idValue = stoi(idText);
            int ageValue = stoi(ageText);
            if (idValue < 1 || ageValue < 0 || ageValue > 130 || name.empty() ||
                disease.empty() || !validContact(contact) || findPatientIndex(idValue) != -1) {
                continue;
            }
            patientID[count] = idValue;
            patientName[count] = name;
            patientAge[count] = ageValue;
            patientDisease[count] = disease;
            patientContact[count] = contact;
            count++;
        } catch (...) {
            // Ignore a malformed line instead of stopping the entire program.
        }
    }
}

void displayOne(int index) {
    cout << "\nPatient ID : " << patientID[index]
         << "\nName       : " << patientName[index]
         << "\nAge        : " << patientAge[index]
         << "\nDisease    : " << patientDisease[index]
         << "\nContact    : " << patientContact[index] << "\n";
}

void addPatient() {
    if (count == MAX) {
        cout << "The array is full. The maximum is " << MAX << " patients.\n";
        return;
    }

    int idValue = readInt("Enter patient ID: ", 1, numeric_limits<int>::max());
    if (findPatientIndex(idValue) != -1) {
        cout << "That patient ID already exists.\n";
        return;
    }

    patientID[count] = idValue;
    patientName[count] = readText("Enter full name: ", 80);
    patientAge[count] = readInt("Enter age (0-130): ", 0, 130);
    patientDisease[count] = readText("Enter disease/condition: ", 100);
    patientContact[count] = readContact();

    count++;
    if (saveRecords()) {
        cout << "Patient added and saved to " << DATA_FILE << ".\n";
    } else {
        count--;
        cout << "Could not save the record. Check folder permissions and try again.\n";
    }
}

void displayPatients() {
    if (count == 0) {
        cout << "No patient records found. Add a patient to begin.\n";
        return;
    }

    cout << "\n" << left << setw(10) << "ID" << setw(24) << "NAME"
         << setw(8) << "AGE" << setw(24) << "DISEASE" << "CONTACT\n";
    cout << string(82, '-') << "\n";
    for (int i = 0; i < count; i++) {
        cout << left << setw(10) << patientID[i]
             << setw(24) << patientName[i].substr(0, 22)
             << setw(8) << patientAge[i]
             << setw(24) << patientDisease[i].substr(0, 22)
             << patientContact[i] << '\n';
    }
}

void searchPatient() {
    int idValue = readInt("Enter patient ID to search: ", 1, numeric_limits<int>::max());
    int index = findPatientIndex(idValue);
    if (index == -1) cout << "Patient not found.\n";
    else displayOne(index);
}

void updatePatient() {
    int idValue = readInt("Enter patient ID to update: ", 1, numeric_limits<int>::max());
    int index = findPatientIndex(idValue);
    if (index == -1) {
        cout << "Patient not found.\n";
        return;
    }

    // Keep a copy in case writing to the file fails.
    string oldName = patientName[index];
    int oldAge = patientAge[index];
    string oldDisease = patientDisease[index];
    string oldContact = patientContact[index];

    cout << "Enter the new details below.\n";
    patientName[index] = readText("New full name: ", 80);
    patientAge[index] = readInt("New age (0-130): ", 0, 130);
    patientDisease[index] = readText("New disease/condition: ", 100);
    patientContact[index] = readContact();

    if (saveRecords()) {
        cout << "Patient details updated and saved.\n";
    } else {
        patientName[index] = oldName;
        patientAge[index] = oldAge;
        patientDisease[index] = oldDisease;
        patientContact[index] = oldContact;
        cout << "Could not save changes. The previous details have been restored in memory.\n";
    }
}

void sortPatients() {
    // Bubble Sort by ID. Swap every field so each complete record stays together.
    for (int i = 0; i < count - 1; i++) {
        for (int j = 0; j < count - i - 1; j++) {
            if (patientID[j] > patientID[j + 1]) {
                swap(patientID[j], patientID[j + 1]);
                swap(patientName[j], patientName[j + 1]);
                swap(patientAge[j], patientAge[j + 1]);
                swap(patientDisease[j], patientDisease[j + 1]);
                swap(patientContact[j], patientContact[j + 1]);
            }
        }
    }
    if (saveRecords()) cout << "Patients sorted by ID and saved.\n";
    else cout << "Sorted in memory, but could not save the file.\n";
}

int main() {
    loadRecords();
    cout << "==========================================\n";
    cout << "    HOSPITAL PATIENT RECORD SYSTEM\n";
    cout << "==========================================\n";
    cout << "Loaded " << count << " record(s) from " << DATA_FILE << ".\n";

    int choice;
    do {
        cout << "\n1. Add Patient\n";
        cout << "2. Display All Patients\n";
        cout << "3. Search Patient by ID\n";
        cout << "4. Sort Patients by ID\n";
        cout << "5. Update Patient\n";
        cout << "6. Exit\n";
        choice = readInt("Enter your choice (1-6): ", 1, 6);

        switch (choice) {
            case 1: addPatient(); break;
            case 2: displayPatients(); break;
            case 3: searchPatient(); break;
            case 4: sortPatients(); break;
            case 5: updatePatient(); break;
            case 6: cout << "Records remain saved in " << DATA_FILE << ". Goodbye!\n"; break;
        }
    } while (choice != 6);

    return 0;
}
